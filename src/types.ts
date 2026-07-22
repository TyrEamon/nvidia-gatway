export interface Model {
  id: string
  enabled: boolean
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai'
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  messages?: Array<{ role: string; content: string }>
  [key: string]: unknown
}

export interface RaceParticipant {
  providerId: string
  providerName: string
  keyIndex: number
  keyLabel: string
  keyFingerprint: string
}

export interface RaceWinnerLog {
  id: string
  timestamp: string
  outcome?: 'success' | 'failure'
  providerId: string
  providerName?: string
  model?: string
  method: string
  path: string
  keyIndex: number
  sourceKeyIndex?: number
  keyLabel: string
  keyFingerprint: string
  attempt: number
  racedKeys: number
  participants?: RaceParticipant[]
  latencyMs: number
  statusCode: number
  errorDetail?: string
  responsePreview?: string
}

export interface AppSettings {
  debugLoggingEnabled: boolean
}

export interface TestModelRequest {
  modelId: string
}

export interface TestApiKeyRequest {
  apiKey: string
  baseUrl?: string
  modelId?: string
  strictModel?: boolean
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl?: string
  apiType?: 'openai'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
}

export interface UpdateAppSettingsRequest {
  debugLoggingEnabled?: boolean
}

export interface DataBackup {
  version: 1
  exportedAt: string
  providers: Provider[]
  proxyKeys: ProxyKey[]
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  NVIDIA_RACE_MAX_KEYS?: string
  NVIDIA_RACE_PER_KEY_RETRIES?: string
  NVIDIA_RACE_ATTEMPT_TIMEOUT_MS?: string
  NVIDIA_RACE_OVERALL_TIMEOUT_MS?: string
  UPSTREAM_RACE_MAX_KEYS?: string
  UPSTREAM_RACE_PER_KEY_RETRIES?: string
  UPSTREAM_RACE_ATTEMPT_TIMEOUT_MS?: string
  UPSTREAM_RACE_OVERALL_TIMEOUT_MS?: string
}
