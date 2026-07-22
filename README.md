# NVIDIA Gateway Cloudflare 部署版

这是一个可直接 Fork / 导入 Cloudflare Workers 部署的 OpenAI-compatible NVIDIA 多 Key 竞速代理。

客户端请求地址：

```text
https://你的-worker域名/v1
```

模型 ID 直接填写 NVIDIA / 上游真实模型 ID，例如：

```text
deepseek-ai/deepseek-v4-flash
deepseek-ai/deepseek-v4-pro
```

## 功能

- OpenAI 兼容 `/v1/chat/completions` 和 `/v1/models`
- 后台管理 Provider、上游 API Key、代理访问 Key
- 多 Key / 多 Provider 竞速
- 过滤 `429`、超时、`5xx`、`ResourceExhausted`
- 过滤 `HTTP 200` 里伪装成成功的上游错误
- Debug 开关：默认不写竞速日志，打开后只保留最近日志
- 支持作为下游 NVIDIA gateway，也支持作为中控 controller

## 一、Fork 或上传 GitHub

1. Fork 这个仓库，或新建仓库后上传本项目文件。
2. 不要上传 `node_modules`、`.wrangler`、`.dev.vars`。
3. 如果你的 Cloudflare Worker 项目名不是 `nvidia-gatway`，把 `wrangler.toml` 里的 `name` 改成你的 Worker 名。

## 二、连接 Cloudflare 部署

进入 Cloudflare Dashboard：

```text
Workers & Pages -> Create -> Worker -> Import a repository
```

选择你的 GitHub 仓库。

构建配置：

| 配置项 | 填写 |
| --- | --- |
| Root directory | 留空或 `/` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |

> 不建议填 `npx wrangler deploy`，因为项目里的 `npm run deploy` 已经带了 `--keep-vars`。

## 三、KV 绑定

`wrangler.toml` 已经写了：

```toml
[[kv_namespaces]]
binding = "KV"
```

没有写 `id` 是故意的。Cloudflare Workers Builds / Wrangler 会在第一次部署时自动创建并绑定 KV。

如果你想手动绑定已有 KV，也可以把配置改成：

```toml
[[kv_namespaces]]
binding = "KV"
id = "你的 KV namespace ID"
```

绑定名必须是大写：

```text
KV
```

不要让多个部署共用同一个 KV，否则后台配置、日志和 proxy key 会混在一起。

## 四、环境变量

在 Cloudflare Worker 的 `Variables and Secrets` 里添加：

| 变量 | 示例 | 说明 |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | 管理后台用户名 |
| `ADMIN_PASSWORD` | `your-secure-password` | 管理后台密码 |

可选竞速变量：

| 变量 | 推荐值 | 说明 |
| --- | ---: | --- |
| `UPSTREAM_RACE_MAX_KEYS` | `6` | 每次最大并发竞速候选数，Cloudflare 免费环境建议不要太大 |
| `UPSTREAM_RACE_PER_KEY_RETRIES` | `2` | 每个候选最大尝试次数 |
| `UPSTREAM_RACE_ATTEMPT_TIMEOUT_MS` | `6000` | 单次上游超时 |
| `UPSTREAM_RACE_OVERALL_TIMEOUT_MS` | `30000` | 整轮竞速总超时 |

如果部署成中控 controller，建议更保守：

```text
UPSTREAM_RACE_MAX_KEYS=2
UPSTREAM_RACE_PER_KEY_RETRIES=1
UPSTREAM_RACE_ATTEMPT_TIMEOUT_MS=8000
UPSTREAM_RACE_OVERALL_TIMEOUT_MS=30000
```

## 五、后台配置

部署成功后访问：

```text
https://你的-worker域名/admin
```

### 作为 NVIDIA gateway

添加 Provider：

```text
名称：NVIDIA
ID：nvidia
API 地址：https://integrate.api.nvidia.com/v1
API Key：填写你的 NVIDIA API Key
模型：deepseek-ai/deepseek-v4-flash 等
```

然后在后台生成一个代理 Key，格式类似：

```text
sk_cf_xxxxx
```

客户端使用：

```text
Base URL：https://你的-worker域名/v1
API Key：后台生成的 sk_cf_xxxxx
Model：deepseek-ai/deepseek-v4-flash
```

### 作为中控 controller

中控的 Provider 不填 NVIDIA key，而是填下游 gateway：

```text
名称：gateway-1
ID：gateway1
API 地址：https://gateway-1.example.workers.dev/v1
API Key：gateway-1 后台生成的 sk_cf_xxxxx
模型：deepseek-ai/deepseek-v4-flash 等
```

多个 gateway 就添加多个 Provider。

## 常见问题

### 1. 报 `KV namespace 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID' is not valid`

说明你还在用旧版配置。请更新仓库，确保 `wrangler.toml` 里没有 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。

### 2. 提示 Worker name 不匹配

把 `wrangler.toml` 里的：

```toml
name = "nvidia-gatway"
```

改成 Cloudflare 里创建的 Worker 项目名。

### 3. 后台保存配置失败

检查 Worker 绑定里有没有名为 `KV` 的 KV namespace。必须是大写 `KV`。

### 4. Debug 日志要不要开

默认关闭。只有排查问题时打开。Cloudflare 免费 KV 写入次数有限，长期打开 Debug 容易消耗 KV 写入额度。

### 5. `deepseek-v4-pro` 比 `flash` 更容易失败

`pro` 往往更慢、更容易排队。建议把竞速并发降一点、超时时间加长一点。
