# Gateway Controller Plan

## Goal

Reuse this project in two roles:

- Downstream gateway: keep the current NVIDIA key pool racing behavior.
- Controller gateway: configure several downstream gateways as providers, then race those gateways.

The controller should not store NVIDIA keys. It stores downstream gateway URLs and their `sk_cf_*` proxy keys only.

## Architecture

```text
Client
  -> Controller deployment
    -> Gateway 1 deployment
      -> NVIDIA
    -> Gateway 2 deployment
      -> NVIDIA
    -> Gateway 3 deployment
      -> NVIDIA
```

Each deployment keeps its own KV namespace. Do not share KV between controller and downstream gateways.

The default `wrangler.toml` does not declare a KV namespace. Bind one manually in the Cloudflare dashboard for each deployment:

- Binding name: `KV`
- Namespace: the KV namespace dedicated to that deployment

If the binding name is not exactly `KV`, the Worker will not be able to read its configuration.

## Provider Mapping

For a downstream NVIDIA gateway:

- `baseUrl`: `https://integrate.api.nvidia.com/v1`
- `apiKeys`: NVIDIA API keys

For a controller:

- `baseUrl`: `https://gateway-1.example.workers.dev/v1`
- `apiKeys`: the downstream gateway's `sk_cf_*` proxy key

The controller forwards OpenAI-compatible `/v1/*` requests to each downstream gateway. The downstream gateway then handles NVIDIA key racing.

## First Implementation

1. Keep the existing admin UI, provider model, proxy key auth, and KV layout.
2. Generalize racing from "NVIDIA provider only" to enabled providers.
3. Race candidates as `provider + apiKey + baseUrl`, so each candidate uses its own upstream URL.
4. Keep the existing `NVIDIA_RACE_*` environment variables for backward compatibility.
5. Add `UPSTREAM_RACE_*` aliases for controller deployments.
6. Keep debug logs disabled by default.
7. Do not delete old debug log KV keys during a request. Read only the latest 20 and let TTL expire old logs.

## Recommended Runtime Settings

Downstream gateways:

```text
UPSTREAM_RACE_MAX_KEYS=6
UPSTREAM_RACE_PER_KEY_RETRIES=2
```

Controller:

```text
UPSTREAM_RACE_MAX_KEYS=2 or 3
UPSTREAM_RACE_PER_KEY_RETRIES=1 or 2
```

Start conservatively. The value of the controller is wider routing sampling, not multiplying every request into the worst-case fanout.

## Later Improvements

- Gateway health scoring and short cooldown for repeated `ResourceExhausted`, `429`, or `5xx`.
- Delayed hedging, for example start one gateway now and add another after 300-600 ms.
- Durable Object scheduler if exact global coordination becomes necessary.
- Separate controller-focused admin labels.
