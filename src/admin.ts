import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  getRaceWinnerLogs,
  getAppSettings,
  setAppSettings,
  replaceProviders,
  replaceProxyKeys,
} from './storage'
import { testModelConnection } from './proxy'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, NVIDIA_DEFAULT_BASE_URL, NVIDIA_DEFAULT_MODELS } from './config'
import type {
  Env,
  ApiResponse,
  Provider,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
  TestApiKeyRequest,
  DataBackup,
  ProxyKey,
  UpdateAppSettingsRequest,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProviderArray(value: unknown): value is Provider[] {
  if (!Array.isArray(value)) return false
  return value.every((item) => isObject(item) &&
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.baseUrl === 'string' &&
    Array.isArray(item.apiKeys) &&
    Array.isArray(item.models) &&
    typeof item.enabled === 'boolean')
}

function isProxyKeyArray(value: unknown): value is ProxyKey[] {
  if (!Array.isArray(value)) return false
  return value.every((item) => isObject(item) &&
    typeof item.id === 'string' &&
    typeof item.key === 'string' &&
    typeof item.name === 'string' &&
    typeof item.enabled === 'boolean' &&
    typeof item.createdAt === 'string')
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

export async function handleGetRaceWinnerLogs(c: Context<{ Bindings: Env }>) {
  const logs = await getRaceWinnerLogs(c.env, 20)
  return c.json<ApiResponse>({ success: true, data: logs })
}

export async function handleGetSettings(c: Context<{ Bindings: Env }>) {
  const settings = await getAppSettings(c.env)
  return c.json<ApiResponse>({ success: true, data: settings })
}

export async function handleUpdateSettings(c: Context<{ Bindings: Env }>) {
  let body: UpdateAppSettingsRequest
  try {
    body = await c.req.json<UpdateAppSettingsRequest>()
  } catch {
    return c.json<ApiResponse>({ success: false, message: 'Invalid JSON' }, 400)
  }

  const settings = await getAppSettings(c.env)
  if (body.debugLoggingEnabled !== undefined) {
    settings.debugLoggingEnabled = body.debugLoggingEnabled === true
  }

  await setAppSettings(c.env, settings)
  return c.json<ApiResponse>({ success: true, data: settings })
}

export async function handleExportData(c: Context<{ Bindings: Env }>) {
  const backup: DataBackup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    providers: await getProviders(c.env),
    proxyKeys: await getProxyKeys(c.env),
  }
  const date = backup.exportedAt.slice(0, 10)
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="nvidia-gateway-backup-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}

export async function handleImportData(c: Context<{ Bindings: Env }>) {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json<ApiResponse>({ success: false, message: '导入文件不是有效 JSON' }, 400)
  }

  if (!isObject(body) || body.version !== 1 || !isProviderArray(body.providers) || !isProxyKeyArray(body.proxyKeys)) {
    return c.json<ApiResponse>({ success: false, message: '备份文件格式不正确或版本不支持' }, 400)
  }

  const now = new Date().toISOString()
  const providers = body.providers.map((provider) => ({
    ...provider,
    baseUrl: (provider.baseUrl || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiType: provider.apiType || 'openai' as const,
    updatedAt: now,
  }))

  await replaceProviders(c.env, providers)
  await replaceProxyKeys(c.env, body.proxyKeys)

  return c.json<ApiResponse>({
    success: true,
    data: { providersCount: providers.length, proxyKeysCount: body.proxyKeys.length },
    message: '导入成功',
  })
}

// ===== 提供商 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  const id = body.id?.trim()
  const name = body.name?.trim()

  if (!id || !name) {
    return c.json<ApiResponse>({ success: false, message: 'id、name 为必填项' }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === id)) {
    return c.json<ApiResponse>({ success: false, message: `提供商 id "${id}" 已存在` }, 409)
  }

  const apiKeys = normalizeArray(body.apiKeys, (key) => ({ key, enabled: true }))
    .map((entry) => ({ ...entry, key: entry.key.trim() }))
    .filter((entry) => entry.key)
  const models = normalizeArray(body.models, (modelId) => ({ id: modelId, enabled: true }))
    .map((model) => ({ ...model, id: model.id.trim() }))
    .filter((model) => model.id)

  if (apiKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: 'apiKeys 至少需要一个' }, 400)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id,
    name,
    baseUrl: (body.baseUrl?.trim() || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    apiKeys,
    models: models.length > 0 ? models : NVIDIA_DEFAULT_MODELS.map((modelId) => ({ id: modelId, enabled: true })),
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) {
    updates.baseUrl = (body.baseUrl.trim() || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, '')
  }
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeArray(body.models, (m) => ({ id: m, enabled: true }))
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '提供商已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于提供商 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  if (enabledKeys.length === 0) {
    return c.json<ApiResponse>({ success: false, message: '该提供商未配置可用的 API Key' }, 400)
  }

  const apiKey = enabledKeys[0].key
  const result = await testModelConnection(provider.baseUrl, apiKey, modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

async function testNvidiaModelsEndpoint(baseUrl: string, apiKey: string): Promise<{ success: boolean; statusCode?: number; models: string[]; message?: string }> {
  try {
    const cleanBase = (baseUrl || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, '')
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) return { success: false, statusCode: response.status, models: [], message: `HTTP ${response.status}` }
    const data = await response.json() as { data?: Array<{ id?: string }> }
    const models = (data.data || []).map((model) => model.id).filter((id): id is string => !!id)
    return { success: true, statusCode: response.status, models }
  } catch {
    return { success: false, models: [], message: 'NVIDIA models endpoint failed' }
  }
}

export async function handleTestApiKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<TestApiKeyRequest>()
  const apiKey = body.apiKey?.trim()
  if (!apiKey) {
    return c.json<ApiResponse>({ success: false, message: 'apiKey 为必填项' }, 400)
  }

  const baseUrl = (body.baseUrl?.trim() || NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, '')
  const modelId = body.modelId?.trim() || NVIDIA_DEFAULT_MODELS[0]
  const modelsResult = await testNvidiaModelsEndpoint(baseUrl, apiKey)
  if (!body.strictModel && modelsResult.success) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: true, message: 'NVIDIA key is reachable', statusCode: modelsResult.statusCode, modelId, models: modelsResult.models },
    })
  }

  const completionResult = await testModelConnection(baseUrl, apiKey, modelId, 'openai')
  const result = body.strictModel
    ? completionResult
    : completionResult.success
      ? completionResult
      : modelsResult.success
        ? { success: true, message: `NVIDIA key is reachable; completion test returned ${completionResult.message}`, statusCode: modelsResult.statusCode }
        : completionResult

  return c.json<ApiResponse>({
    success: true,
    data: { ...result, modelId, models: modelsResult.models },
  })
}

// ===== 转发 Key 管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '转发 Key 已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '转发 Key 不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}
