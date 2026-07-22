import { Context } from 'hono'
import { addRaceWinnerLog, getAppSettings, getProviders } from './storage'
import type { ApiKeyEntry, Env, Provider, ProxyRequestBody, RaceParticipant, RaceWinnerLog } from './types'

interface UpstreamRacingConfig {
  maxRacingKeys: number
  perKeyRetries: number
  attemptTimeoutMs: number
  overallTimeoutMs: number
}

interface RacingTask {
  id: number
  key: RacingKey
  controller: AbortController
  promise: Promise<SettledRacingTask>
}

interface RacingKey {
  provider: Provider
  key: ApiKeyEntry
  sourceKeyIndex: number
}

type KeyWorkerResult =
  | { type: 'success'; response: Response; keyIndex: number; attempt: number; responsePreview?: string }
  | { type: 'failed'; status: number; detail: string; hard: boolean; keyIndex: number }
  | { type: 'aborted'; keyIndex: number }

type SettledRacingTask = {
  taskId: number
  result: KeyWorkerResult
}

const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

const UPSTREAM_RACING_DEFAULTS: UpstreamRacingConfig = {
  // Cloudflare Workers allows about 6 simultaneous outgoing connections per invocation.
  maxRacingKeys: 6,
  perKeyRetries: 2,
  attemptTimeoutMs: 6000,
  overallTimeoutMs: 30000,
}

function parseIntegerOption(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function firstConfiguredOption(primary: string | undefined, fallback: string | undefined): string | undefined {
  return primary || fallback
}

function getUpstreamRacingConfig(env: Env): UpstreamRacingConfig {
  return {
    maxRacingKeys: parseIntegerOption(firstConfiguredOption(env.UPSTREAM_RACE_MAX_KEYS, env.NVIDIA_RACE_MAX_KEYS), UPSTREAM_RACING_DEFAULTS.maxRacingKeys, 1, 6),
    perKeyRetries: parseIntegerOption(firstConfiguredOption(env.UPSTREAM_RACE_PER_KEY_RETRIES, env.NVIDIA_RACE_PER_KEY_RETRIES), UPSTREAM_RACING_DEFAULTS.perKeyRetries, 1, 5),
    attemptTimeoutMs: parseIntegerOption(firstConfiguredOption(env.UPSTREAM_RACE_ATTEMPT_TIMEOUT_MS, env.NVIDIA_RACE_ATTEMPT_TIMEOUT_MS), UPSTREAM_RACING_DEFAULTS.attemptTimeoutMs, 1000, 30000),
    overallTimeoutMs: parseIntegerOption(firstConfiguredOption(env.UPSTREAM_RACE_OVERALL_TIMEOUT_MS, env.NVIDIA_RACE_OVERALL_TIMEOUT_MS), UPSTREAM_RACING_DEFAULTS.overallTimeoutMs, 3000, 120000),
  }
}

function randomInt(maxExclusive: number): number {
  const random = new Uint32Array(1)
  const limit = 0xffffffff - (0xffffffff % maxExclusive)
  let value = 0

  do {
    crypto.getRandomValues(random)
    value = random[0]
  } while (value >= limit)

  return value % maxExclusive
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

async function getEnabledProviders(env: Env): Promise<Provider[]> {
  const providers = await getProviders(env)
  return providers.filter((provider) => provider.enabled)
}

function providerAllowsModel(provider: Provider, model: string): boolean {
  if (provider.models.length === 0) return true
  const modelConfig = provider.models.find((item) => item.id === model)
  return !modelConfig || modelConfig.enabled
}

function getEnabledRacingKeys(providers: Provider[]): RacingKey[] {
  const keys: RacingKey[] = []
  for (const provider of providers) {
    provider.apiKeys.forEach((key, sourceKeyIndex) => {
      if (key.enabled) keys.push({ provider, key, sourceKeyIndex })
    })
  }
  return keys
}

function buildForwardHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }
}

function buildProxyResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

function isTransientUpstreamStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 499 || status >= 500
}

function looksTransientUpstreamError(detail: string): boolean {
  const lower = detail.toLowerCase()
  return [
    'resourceexhausted',
    'resource exhausted',
    'worker local total request limit reached',
    'rate limit',
    'rate_limit',
    'too many requests',
    'temporar',
    'try again',
    'capacity',
    'overload',
    'busy',
    'timeout',
    'timed out',
    'upstream',
    'gateway',
    'service unavailable',
    'internal server error',
  ].some((marker) => lower.includes(marker))
}

async function readErrorSnippet(response: Response, maxLength = 1000): Promise<string> {
  try {
    const text = await response.text()
    return text.substring(0, maxLength)
  } catch {
    return ''
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return

  try {
    await response.body.cancel()
  } catch {
    // The runtime may have already closed the body.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || 'Request failed')
}

function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.substring(0, 8)}****${key.substring(key.length - 4)}`
}

async function keyFingerprint(key: string): Promise<string> {
  const data = new TextEncoder().encode(key)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const bytes = [...new Uint8Array(hash)].slice(0, 4)
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function createRaceParticipants(racingKeys: RacingKey[]): Promise<RaceParticipant[]> {
  return Promise.all(racingKeys.map(async (entry) => ({
    providerId: entry.provider.id,
    providerName: entry.provider.name,
    keyIndex: entry.sourceKeyIndex,
    keyLabel: maskKey(entry.key.key),
    keyFingerprint: await keyFingerprint(entry.key.key),
  })))
}

async function createRaceWinnerLog(params: {
  outcome: 'success' | 'failure'
  provider: Provider
  model?: string
  method: string
  path: string
  winnerKey?: string
  keyIndex?: number
  sourceKeyIndex?: number
  attempt: number
  racedKeys: number
  participants: RaceParticipant[]
  latencyMs: number
  statusCode: number
  errorDetail?: string
  responsePreview?: string
}): Promise<RaceWinnerLog> {
  const timestamp = new Date().toISOString()
  const reverseTime = String(9999999999999 - Date.now()).padStart(13, '0')
  const id = `${reverseTime}:${crypto.randomUUID()}`
  const winnerKey = params.winnerKey || ''
  return {
    id,
    timestamp,
    outcome: params.outcome,
    providerId: params.provider.id,
    providerName: params.provider.name,
    model: params.model,
    method: params.method,
    path: params.path,
    keyIndex: params.keyIndex ?? -1,
    sourceKeyIndex: params.sourceKeyIndex ?? -1,
    keyLabel: winnerKey ? maskKey(winnerKey) : 'all-failed',
    keyFingerprint: winnerKey ? await keyFingerprint(winnerKey) : '',
    attempt: params.attempt,
    racedKeys: params.racedKeys,
    participants: params.participants,
    latencyMs: params.latencyMs,
    statusCode: params.statusCode,
    errorDetail: params.errorDetail?.substring(0, 500),
    responsePreview: params.responsePreview?.substring(0, 1000),
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

function looksLikeUpstreamErrorPayload(preview: string): boolean {
  const lower = preview.toLowerCase()
  if (looksTransientUpstreamError(preview)) return true
  return lower.includes('"error"') && (
    lower.includes('"type"') ||
    lower.includes('"code"') ||
    lower.includes('internal_server_error') ||
    lower.includes('data:')
  )
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error('The operation was aborted')

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Response preview timed out')), timeoutMs)
    abortHandler = () => reject(new Error('The operation was aborted'))
    signal.addEventListener('abort', abortHandler, { once: true })
  })

  try {
    return await Promise.race([reader.read(), abortPromise])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

async function inspectOkResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes = 1000,
  previewTimeoutMs = 5000
): Promise<
  | { ok: true; response: Response; preview: string }
  | { ok: false; status: number; detail: string }
> {
  if (!response.body) return { ok: true, response, preview: '' }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (total < maxBytes) {
      const { value, done } = await readWithTimeout(reader, signal, previewTimeoutMs)
      if (done || !value) break
      chunks.push(value)
      total += value.length
      if (total > 0 && new TextDecoder().decode(concatChunks(chunks, total)).includes('\n\n')) break
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    return { ok: false, status: 502, detail: errorMessage(err) }
  }

  const previewBytes = concatChunks(chunks, total)
  const preview = new TextDecoder().decode(previewBytes.slice(0, maxBytes))
  if (looksLikeUpstreamErrorPayload(preview)) {
    await reader.cancel().catch(() => {})
    return { ok: false, status: 502, detail: preview.substring(0, 500) }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (previewBytes.length > 0) controller.enqueue(previewBytes)

      const pump = (): void => {
        reader.read()
          .then(({ value, done }) => {
            if (done) {
              controller.close()
              return
            }
            if (value) controller.enqueue(value)
            pump()
          })
          .catch((err) => controller.error(err))
      }
      pump()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return { ok: true, response: new Response(stream, response), preview }
}

async function fetchWithTimeout(url: string, init: RequestInit, parentSignal: AbortSignal, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromParent = () => controller.abort()

  if (parentSignal.aborted) {
    controller.abort()
  } else {
    parentSignal.addEventListener('abort', abortFromParent, { once: true })
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
    parentSignal.removeEventListener('abort', abortFromParent)
  }
}

async function runKeyWorker(params: {
  keyIndex: number
  apiKey: string
  forwardUrl: string
  method: string
  body: ProxyRequestBody
  config: UpstreamRacingConfig
  signal: AbortSignal
}): Promise<KeyWorkerResult> {
  let lastStatus = 502
  let lastDetail = 'Upstream request failed'

  for (let attempt = 1; attempt <= params.config.perKeyRetries; attempt++) {
    if (params.signal.aborted) {
      return { type: 'aborted', keyIndex: params.keyIndex }
    }

    try {
      const response = await fetchWithTimeout(params.forwardUrl, {
        method: params.method,
        headers: buildForwardHeaders(params.apiKey),
        body: JSON.stringify(params.body),
      }, params.signal, params.config.attemptTimeoutMs)

      if (response.ok) {
        const inspected = await inspectOkResponse(response, params.signal, 1000, params.config.attemptTimeoutMs)
        if (inspected.ok) {
          return { type: 'success', response: inspected.response, keyIndex: params.keyIndex, attempt, responsePreview: inspected.preview }
        }
        lastStatus = inspected.status
        lastDetail = inspected.detail
        continue
      }

      lastStatus = response.status

      if (isTransientUpstreamStatus(response.status)) {
        lastDetail = `HTTP ${response.status}`
        await cancelResponseBody(response)
        continue
      }

      const detail = await readErrorSnippet(response)
      lastDetail = detail || `HTTP ${response.status}`

      // Some upstream transient failures arrive as non-429/5xx JSON errors.
      if (response.status === 400 && looksTransientUpstreamError(lastDetail)) {
        continue
      }

      return {
        type: 'failed',
        status: response.status,
        detail: lastDetail,
        hard: response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404,
        keyIndex: params.keyIndex,
      }
    } catch (err) {
      if (params.signal.aborted) {
        return { type: 'aborted', keyIndex: params.keyIndex }
      }
      lastStatus = 502
      lastDetail = errorMessage(err)
    }
  }

  return {
    type: 'failed',
    status: lastStatus,
    detail: lastDetail,
    hard: false,
    keyIndex: params.keyIndex,
  }
}

function abortLosers(tasks: RacingTask[], winnerId?: number): void {
  for (const task of tasks) {
    if (task.id !== winnerId) {
      task.controller.abort()
    }
  }
}

function buildCandidateForwardUrl(candidate: RacingKey, requestUrl: URL): string {
  const subPath = requestUrl.pathname.replace(/^\/v1\/?/, '') || 'chat/completions'
  const cleanBase = (candidate.provider.baseUrl || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, '')
  return `${cleanBase}/${subPath}${requestUrl.search}`
}

async function raceUpstreamKeys(params: {
  c: Context<{ Bindings: Env }>
  fallbackProvider: Provider
  racingKeys: RacingKey[]
  forwardBody: ProxyRequestBody
  method: string
}): Promise<Response> {
  const config = getUpstreamRacingConfig(params.c.env)
  const settings = await getAppSettings(params.c.env)
  const shouldWriteRaceLogs = settings.debugLoggingEnabled
  const selectedKeys = shuffled(params.racingKeys).slice(0, Math.min(params.racingKeys.length, config.maxRacingKeys))
  const requestUrl = new URL(params.c.req.url)

  const tasks: RacingTask[] = []
  const pending = new Set<Promise<SettledRacingTask>>()
  let lastFailure: { status: number; detail: string; hard: boolean } | null = null
  let winnerId: number | undefined
  const startedAt = Date.now()

  for (let i = 0; i < selectedKeys.length; i++) {
    const controller = new AbortController()
    const promise = runKeyWorker({
      keyIndex: i,
      apiKey: selectedKeys[i].key.key,
      forwardUrl: buildCandidateForwardUrl(selectedKeys[i], requestUrl),
      method: params.method,
      body: params.forwardBody,
      config,
      signal: controller.signal,
    })
      .catch((err): KeyWorkerResult => ({
        type: 'failed',
        status: 502,
        detail: errorMessage(err),
        hard: false,
        keyIndex: i,
      }))
      .then((result) => ({ taskId: i, result }))

    tasks.push({
      id: i,
      key: selectedKeys[i],
      controller,
      promise,
    })
    pending.add(promise)
  }

  const overallTimeoutId = setTimeout(() => abortLosers(tasks), config.overallTimeoutMs)

  try {
    while (pending.size > 0) {
      const settled = await Promise.race(pending)
      const settledTask = tasks[settled.taskId]
      if (settledTask) pending.delete(settledTask.promise)

      if (settled.result.type === 'success') {
        const successResult = settled.result
        winnerId = settled.taskId
        clearTimeout(overallTimeoutId)
        abortLosers(tasks, winnerId)
        void Promise.allSettled([...pending])
        const winnerSlot = successResult.keyIndex
        const winnerAttempt = successResult.attempt
        const sourceKeyIndex = selectedKeys[winnerSlot]?.sourceKeyIndex ?? winnerSlot
        const winner = selectedKeys[winnerSlot]
        const winnerKey = winner?.key.key || ''
        const winnerProvider = winner?.provider || params.fallbackProvider
        const latencyMs = Date.now() - startedAt
        const response = buildProxyResponse(successResult.response)
        const statusCode = response.status
        if (shouldWriteRaceLogs) {
          const logPromise = Promise.all([
            createRaceParticipants(selectedKeys),
            Promise.resolve(successResult.responsePreview || ''),
          ])
            .then(([participants, preview]) => createRaceWinnerLog({
              outcome: 'success',
              provider: winnerProvider,
              model: params.forwardBody.model,
              method: params.method,
              path: requestUrl.pathname,
              winnerKey,
              keyIndex: winnerSlot,
              sourceKeyIndex,
              attempt: winnerAttempt,
              racedKeys: selectedKeys.length,
              participants,
              latencyMs,
              statusCode,
              responsePreview: preview,
            }))
            .then((log) => addRaceWinnerLog(params.c.env, log))
            .catch((err) => console.error('race log write failed:', errorMessage(err)))
          params.c.executionCtx.waitUntil(logPromise)
          console.log(JSON.stringify({
            message: 'upstream_race_winner',
            provider: winnerProvider.id,
            providerName: winnerProvider.name,
            racedKeys: selectedKeys.length,
            keyIndex: winnerSlot,
            sourceKeyIndex,
            attempt: winnerAttempt,
            latencyMs,
          }))
        }
        return response
      }

      if (settled.result.type === 'failed') {
        lastFailure = {
          status: settled.result.status,
          detail: settled.result.detail,
          hard: settled.result.hard,
        }
      }
    }
  } finally {
    clearTimeout(overallTimeoutId)
    abortLosers(tasks, winnerId)
  }

  const status = lastFailure?.status || 504
  const detail = lastFailure?.detail || 'Upstream racing request timed out or all attempts were canceled'
  if (shouldWriteRaceLogs) {
    const latencyMs = Date.now() - startedAt
    const logPromise = createRaceParticipants(selectedKeys)
      .then((participants) => createRaceWinnerLog({
        outcome: 'failure',
        provider: params.fallbackProvider,
        model: params.forwardBody.model,
        method: params.method,
        path: requestUrl.pathname,
        attempt: config.perKeyRetries,
        racedKeys: selectedKeys.length,
        participants,
        latencyMs,
        statusCode: status,
        errorDetail: detail,
      }))
      .then((log) => addRaceWinnerLog(params.c.env, log))
      .catch((err) => console.error('race log write failed:', errorMessage(err)))
    params.c.executionCtx.waitUntil(logPromise)
    console.log(JSON.stringify({
      message: 'upstream_race_failed',
      provider: params.fallbackProvider.id,
      providerName: params.fallbackProvider.name,
      racedKeys: selectedKeys.length,
      perKeyRetries: config.perKeyRetries,
      latencyMs,
      status,
      detail: detail.substring(0, 500),
    }))
  }
  return params.c.json({
    error: {
      message: `All upstream racing attempts failed; last HTTP status: ${status}`,
      type: 'upstream_race_exhausted',
      detail: detail.substring(0, 500),
      raced_keys: selectedKeys.length,
      per_key_retries: config.perKeyRetries,
      hard_error: lastFailure?.hard || false,
    },
  }, status as Parameters<typeof params.c.json>[1])
}

export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  _apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const cleanBase = (baseUrl || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, '')
  let lastStatus: number | undefined
  let lastMessage = 'Upstream connection failed'

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${cleanBase}/chat/completions`, {
        method: 'POST',
        headers: buildForwardHeaders(apiKey),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15000),
      })

      if (response.ok) {
          return { success: true, message: 'Upstream connection succeeded', statusCode: response.status }
      }

      lastStatus = response.status

      if (isTransientUpstreamStatus(response.status)) {
        lastMessage = `HTTP ${response.status}`
        await cancelResponseBody(response)
        continue
      }

      const errorBody = await readErrorSnippet(response, 200)
      lastMessage = `HTTP ${response.status}: ${errorBody}`

      if (response.status === 400 && looksTransientUpstreamError(errorBody)) {
        continue
      }

      return { success: false, message: lastMessage, statusCode: response.status }
    } catch (err) {
      const error = err as Error
      lastMessage = `Upstream connection failed: ${error.message?.substring(0, 200) || 'unknown error'}`
    }
  }

  return { success: false, message: lastMessage, statusCode: lastStatus }
}

export async function handleProxy(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ProxyRequestBody>()
    const model = body.model

    if (!model) {
      return c.json({ error: { message: 'Missing model parameter', type: 'invalid_request_error' } }, 400)
    }

    const enabledProviders = await getEnabledProviders(c.env)
    if (!enabledProviders.length) {
      return c.json({
        error: { message: 'No enabled upstream providers are configured', type: 'configuration_error' },
      }, 500)
    }

    const racingProviders = enabledProviders.filter((provider) => providerAllowsModel(provider, model))
    if (!racingProviders.length) {
      return c.json({ error: { message: `Model "${model}" is disabled`, type: 'model_disabled' } }, 403)
    }

    const provider = racingProviders[0]
    const racingKeys = getEnabledRacingKeys(racingProviders)
    if (racingKeys.length === 0) {
      return c.json({
        error: { message: 'No enabled upstream API keys are configured', type: 'configuration_error' },
      }, 500)
    }

    return raceUpstreamKeys({
      c,
      fallbackProvider: provider,
      racingKeys,
      forwardBody: body,
      method: c.req.method,
    })
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: error.message || 'Upstream proxy internal error', type: 'server_error' },
    }, 500)
  }
}

export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getEnabledProviders(c.env)

  if (!providers.length) {
    return c.json({ object: 'list', data: [] })
  }

  const models = new Map<string, { id: string; provider: string; provider_name: string; object: string; created: number; owned_by: string }>()
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!model.enabled || models.has(model.id)) continue
      models.set(model.id, {
        id: model.id,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: [...models.values()],
  })
}
