# NVIDIA Gateway API

本文档描述当前 NVIDIA 专用版本的接口行为。管理后台接口基本保留原项目结构，但代理层已经不再解析 `提供商ID/模型ID`，也不再支持 Anthropic 转发。

## 认证

所有 `/v1/*` 代理请求都需要使用管理后台生成的转发 Key：

```http
Authorization: Bearer sk_cf_xxx
```

NVIDIA 上游 API Key 在管理后台的 `nvidia` 提供商里配置，客户端不会直接使用 NVIDIA Key。

## Models

### GET `/v1/models`

返回 NVIDIA 提供商中启用的模型。模型 ID 为 NVIDIA 原始模型 ID，不添加提供商前缀。

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-ai/deepseek-v4-flash",
      "provider": "nvidia",
      "provider_name": "NVIDIA",
      "object": "model",
      "created": 1783287005,
      "owned_by": "nvidia"
    }
  ]
}
```

## Chat Completions

### POST `/v1/chat/completions`

请求体按 NVIDIA OpenAI-compatible API 原样转发。`model` 字段必须使用 NVIDIA 原始模型 ID，例如 `deepseek-ai/deepseek-v4-flash`。

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer sk_cf_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-ai/deepseek-v4-flash",
    "messages": [{ "role": "user", "content": "hi" }],
    "stream": true
  }'
```

成功时直接透传 NVIDIA 的响应 body，包含流式响应。

## 其他 `/v1/*` 路径

其他路径会把 `/v1/` 后的子路径拼到 NVIDIA base URL 后再转发，例如：

- `/v1/chat/completions` -> `https://integrate.api.nvidia.com/v1/chat/completions`
- `/v1/models` 由本 Worker 根据配置生成，不走竞速代理

## NVIDIA Key 竞速策略

每个客户端请求进入代理后，会执行以下策略：

1. 从启用的 NVIDIA Key 池中随机选择最多 `NVIDIA_RACE_MAX_KEYS` 个 Key。
2. 这些 Key 同时向 NVIDIA API 发起请求。
3. 每个 Key worker 内部最多尝试 `NVIDIA_RACE_PER_KEY_RETRIES` 次。
4. `2xx` 响应最先返回者胜出，Worker 立即把该响应流式返回客户端。
5. 其他未胜出的请求会被 abort。
6. `429`、超时、网络错误、`408/409/425/499/5xx` 和部分看起来像临时容量错误的 `400` 会被快速过滤并进入下一次有限重试。
7. `400/401/403/404` 等硬错误不会让该 Key 无限重试，但也不会立刻拉黑整个 Key 池。

失败时返回：

```json
{
  "error": {
    "message": "All NVIDIA key racing attempts failed; last HTTP status: 502",
    "type": "nvidia_race_exhausted",
    "detail": "HTTP 429",
    "raced_keys": 6,
    "per_key_retries": 2,
    "hard_error": false
  }
}
```

## 可配置环境变量

| 变量 | 默认值 | 范围 | 说明 |
| --- | ---: | --- | --- |
| `NVIDIA_RACE_MAX_KEYS` | `6` | `1..6` | 单请求横向竞速 Key 数。 |
| `NVIDIA_RACE_PER_KEY_RETRIES` | `2` | `1..5` | 每个 Key 内部尝试次数。 |
| `NVIDIA_RACE_ATTEMPT_TIMEOUT_MS` | `6000` | `1000..30000` | 单次上游请求超时。 |
| `NVIDIA_RACE_OVERALL_TIMEOUT_MS` | `30000` | `3000..120000` | 整体竞速超时。 |

## 管理接口

管理后台仍使用原来的接口：

- `GET /admin/api/status`
- `GET /admin/api/providers`
- `POST /admin/api/providers`
- `PUT /admin/api/providers/:id`
- `DELETE /admin/api/providers/:id`
- `POST /admin/api/providers/:id/test-model`
- `GET /admin/api/proxy-keys`
- `POST /admin/api/proxy-keys`
- `PATCH /admin/api/proxy-keys/:id`
- `DELETE /admin/api/proxy-keys/:id`

实际代理只会查找 `id` 为 `nvidia` 的提供商；如果没有，则回退查找名称或 base URL 包含 NVIDIA 的提供商。
