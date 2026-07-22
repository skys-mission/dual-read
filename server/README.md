# Dual Read Server
#
# Quick start (no config file):
#   export OPENAI_API_KEY=sk-your-key
#   go run ./cmd/dual-read-server
#
# Monitor: http://127.0.0.1:8080/admin
# API:     POST http://127.0.0.1:8080/v1/chat/completions
#
# Optional TOML: copy config.example.toml → config.toml
#   go run ./cmd/dual-read-server -config config.toml

## Features

- OpenAI-compatible forwarder with BigCache / Valkey caching
- Cache key v2 (resolved upstream + config generation) with `HIT` / `MISS` / `COALESCED` / `BYPASS`
- Cancellation-safe request coalescing (leader cancel does not abort waiters)
- `/livez` + `/readyz` probes; Prometheus `/metrics`; `X-Request-Id`; log/Admin error redaction
- Singleflight on cache miss (no stampede)
- Optional server API keys (`auth.enabled`) with per-key upstream override
- Client/admin tokens stored as HMAC digests (`data/secrets.json` + `data/auth_pepper`)
- Per-IP / per-client rate limits and concurrency gates (auto-on for public bind; 429 + `Retry-After`)
- Client model → upstream model mapping (global + per-key)
- Embedded admin monitor at `/admin`
- **Settings tab** saves non-secret runtime config to `data/runtime.json`
- Secrets (LLM key, client keys, admin token, Valkey password) live in `data/secrets.json`
- Config schema v2 with `revision` CAS; `config check` / `config migrate --from v1` for upgrades
- Streaming requests rejected explicitly (cache-safe)

## Minimal run

```bash
export OPENAI_API_KEY=sk-xxx
go run ./cmd/dual-read-server
```

Defaults: `127.0.0.1:8080`, DeepSeek upstream, local cache on, admin UI on, auth off.

### Config v2 layout

| File | Contents |
|------|----------|
| `data/runtime.json` | Non-secret overlay: `schema_version`, `revision`, LLM base URL, models, cache shape, client names |
| `data/secrets.json` | Recoverable secrets only (mode `0600`) |
| bootstrap TOML (`-config`) | Listen host/port, admin path (immutable at runtime) |

Priority: `environment > runtime/secrets > bootstrap TOML > defaults`.

Migrate an existing v1 install (fail-fast otherwise):

```bash
go run ./cmd/dual-read-server config check --data-dir ./data
go run ./cmd/dual-read-server config migrate --from v1 --data-dir ./data
```

Runtime settings are editable from **Admin → 设置**:

| 设置页区块 | 对应配置 |
|-----------|---------|
| 上游 LLM | `llm` — 共享 API Key（存 secrets.json） |
| 用户 Key | `clients.items` |
| 缓存 | `cache.local` + `cache.valkey`（Redis/Valkey） |
| 安全 | `admin.token`、`log.level` |

Bootstrap TOML (`-config`) only controls static items like listen address and admin path.

## Install

```bash
go install github.com/skys-mission/dual-read/server/cmd/dual-read-server@latest
dual-read-server   # requires OPENAI_API_KEY
```

From a local clone:

```bash
cd server
go install ./cmd/dual-read-server
```

## Auth + model map (TOML)

```toml
[auth]
enabled = true

[[auth.keys]]
name = "alice"
key = "sk-server-alice"
[auth.keys.models]
"flash" = "deepseek-v4-flash"

[models]
default = "deepseek-v4-flash"
[models.map]
"flash" = "deepseek-v4-flash"
```

Client calls with `Authorization: Bearer sk-server-alice` and `model: "flash"`;
the server rewrites to upstream model and uses the shared `OPENAI_API_KEY` (or
`upstream_api_key` on that key).

## Docker

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for multi-arch builds, read-only rootfs,
Compose (standalone / Valkey / TLS), and orchestrator probes.

```bash
cd server
docker build -t dual-read-server:local .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp:size=64m \
  -v dual-read-data:/app/data \
  -e OPENAI_API_KEY=sk-xxx \
  -e DUAL_READ_ADMIN_TOKEN="$(openssl rand -hex 16)" \
  -e DUAL_READ_ALLOW_INSECURE_PUBLIC=true \
  dual-read-server:local
```

Compose (from `server/`):

```bash
export OPENAI_API_KEY=sk-xxx
export DUAL_READ_ADMIN_TOKEN=$(openssl rand -hex 16)
docker compose up --build
# optional Valkey:  DUAL_READ_CACHE_VALKEY=true docker compose --profile valkey up --build
# optional TLS:     docker compose --profile tls up --build
```

When binding `0.0.0.0`, enable `auth.enabled` and set `admin.token`, or use
`DUAL_READ_ALLOW_INSECURE_PUBLIC=true` only for local demos.

## Environment

| Variable | Meaning |
|----------|---------|
| `OPENAI_API_KEY` | Upstream API key (required unless every auth key has `upstream_api_key`) |
| `OPENAI_BASE_URL` | Upstream base URL |
| `DUAL_READ_HOST` / `DUAL_READ_PORT` | Listen address |
| `DUAL_READ_DATA_DIR` | Runtime/secrets directory (container default `/app/data`) |
| `DUAL_READ_CACHE_LOCAL` / `DUAL_READ_CACHE_VALKEY` | Cache toggles |
| `DUAL_READ_VALKEY_ADDR` / `DUAL_READ_VALKEY_PASSWORD` | Valkey |
| `DUAL_READ_LOG_LEVEL` | `debug` / `info` / … |
| `DUAL_READ_ADMIN_TOKEN` | Admin UI token |
| `DUAL_READ_AUTH_ENABLED` | Force auth on/off |
| `DUAL_READ_ALLOW_INSECURE_PUBLIC` | Allow public bind without auth (demo only) |
| `DUAL_READ_METRICS_ENABLED` / `DUAL_READ_METRICS_TOKEN` / `DUAL_READ_METRICS_PATH` | Prometheus `/metrics` |