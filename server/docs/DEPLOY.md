# Dual Read Server — deployment guide

This document covers production-shaped container runs: non-root image, data
volume, read-only root filesystem, multi-arch builds, Compose stacks, and TLS.

## Image

Build from the `server/` directory (context must be `server/`):

```bash
cd server
docker build -t dual-read-server:local .
```

Multi-arch (requires Buildx):

```bash
./scripts/docker-build.sh          # from repo root; tags dual-read-server:local
# or:
cd server
docker buildx build --platform linux/amd64,linux/arm64 \
  -t dual-read-server:local --load .
```

`--load` only works for a single platform; for dual-arch push to a registry:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/OWNER/dual-read-server:VERSION --push .
```

### Image properties

| Property | Value |
|----------|--------|
| User | `dualread` UID/GID `10001` |
| Data dir | `/app/data` (`VOLUME`, env `DUAL_READ_DATA_DIR`) |
| Listen | `0.0.0.0:8080` by default in the image |
| Health | `GET /livez` |
| Secrets | **none** in the image; pass via env / mounts |

## Run (single container)

```bash
docker run --rm -p 8080:8080 \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --user 10001:10001 \
  -v dual-read-data:/app/data \
  -e OPENAI_API_KEY=sk-xxx \
  -e DUAL_READ_ADMIN_TOKEN="$(openssl rand -hex 16)" \
  -e DUAL_READ_ALLOW_INSECURE_PUBLIC=true \
  dual-read-server:local
```

Then open Admin at `http://127.0.0.1:8080/admin`.

For a public bind **without** `DUAL_READ_ALLOW_INSECURE_PUBLIC`, you must enable
server auth and set an admin token (see server README). Prefer that for any
network-facing deploy.

### Read-only root filesystem

The process only needs to write under `/app/data` (runtime.json, secrets.json,
auth pepper). Mount that as a volume and keep the container `read_only: true`
with a small `tmpfs` on `/tmp`.

## Compose

From `server/`:

```bash
export OPENAI_API_KEY=sk-xxx
export DUAL_READ_ADMIN_TOKEN=$(openssl rand -hex 16)
docker compose up --build
```

### With Valkey

```bash
export DUAL_READ_CACHE_VALKEY=true
docker compose --profile valkey up --build
```

The server uses `DUAL_READ_VALKEY_ADDR=valkey:6379` by default.

### With Caddy TLS

1. Edit `deploy/Caddyfile` (hostname or keep `:443 { tls internal }` for lab).
2. Run:

```bash
docker compose --profile tls up --build
```

Caddy terminates TLS and reverse-proxies to `dual-read-server:8080`. Prefer
putting metrics behind a token (`DUAL_READ_METRICS_TOKEN`) when exposed.

## Probes (orchestrators)

| Probe | Path | Expect |
|-------|------|--------|
| Liveness | `GET /livez` | 200 |
| Readiness | `GET /readyz` | 200, or 503 if Valkey required but down |
| Metrics | `GET /metrics` | Prometheus text (optional token) |

Kubernetes sketch:

```yaml
livenessProbe:
  httpGet: { path: /livez, port: 8080 }
readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
securityContext:
  runAsUser: 10001
  runAsGroup: 10001
  runAsNonRoot: true
  readOnlyRootFilesystem: true
volumeMounts:
  - name: data
    mountPath: /app/data
```

## Checklist before public exposure

1. Set `DUAL_READ_ADMIN_TOKEN` (or admin HMAC via secrets.json).
2. Enable `auth.enabled` / client keys; unset `DUAL_READ_ALLOW_INSECURE_PUBLIC`.
3. Put TLS in front (Caddy/nginx/cloud LB).
4. Mount a persistent volume on `/app/data`.
5. Optionally set `DUAL_READ_METRICS_TOKEN` and scrape privately.
6. Prefer Valkey only when you need shared cache across replicas.
