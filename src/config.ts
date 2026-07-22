import type { Provider } from './types'

export const SITE_CONFIG = {
  title: 'NVIDIA Gateway',
  subtitle: 'NVIDIA 多 Key 竞速代理',
  author: 'QingYun',
  authorUrl: 'https://github.com/yutian81/ai-gateway',
  blogUrl: 'https://blog.notett.com',
  description: 'NVIDIA API 代理网关 — OpenAI 兼容 /v1 接口转发',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

export const SESSION_TTL = 7 * 24 * 60 * 60

export const PROXY_KEY_PREFIX = 'sk_cf_'

export const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1'

export const NVIDIA_DEFAULT_MODELS = [
  'minimaxai/minimax-m2.7',
  'deepseek-ai/deepseek-v4-flash',
  'deepseek-ai/deepseek-v4-pro',
  'z-ai/glm-5.1',
  'z-ai/glm-5.2',
] as const

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  APP_SETTINGS: 'app:settings',
  RACE_WINNER_LOG_PREFIX: 'race:winner:',
} as const

// 有效期选项（秒）
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  'forever': null,
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'nvidia',
    name: 'NVIDIA',
    baseUrl: NVIDIA_DEFAULT_BASE_URL,
    apiType: 'openai',
    apiKeys: [],
    models: NVIDIA_DEFAULT_MODELS.map((id) => ({ id, enabled: true })),
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]
