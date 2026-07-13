#!/usr/bin/env bash
# Smoke: build image, run with read-only rootfs, and exercise a cached chat.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-dual-read-server:smoke}"
MOCK_IMAGE="${MOCK_IMAGE:-dual-read-mock-upstream:smoke}"
NAME="dual-read-smoke-$$"
MOCK_NAME="dual-read-mock-upstream-$$"
NETWORK="dual-read-smoke-$$"
PORT="${PORT:-18080}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  docker rm -f "${MOCK_NAME}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}/server"
echo "[docker-smoke] building ${IMAGE}..."
docker build -t "${IMAGE}" .
echo "[docker-smoke] building deterministic mock upstream..."
docker build -t "${MOCK_IMAGE}" ./testdata/mock-upstream

docker network create "${NETWORK}" >/dev/null
docker run -d --name "${MOCK_NAME}" \
  --network "${NETWORK}" \
  --network-alias mock-upstream \
  --read-only \
  --tmpfs /tmp:size=8m,mode=1777 \
  "${MOCK_IMAGE}" >/dev/null

echo "[docker-smoke] starting container on :${PORT}..."
docker run -d --name "${NAME}" \
  --network "${NETWORK}" \
  --read-only \
  --tmpfs /tmp:size=32m,mode=1777 \
  -p "${PORT}:8080" \
  -e OPENAI_API_KEY=sk-smoke-test \
  -e OPENAI_BASE_URL=http://mock-upstream:8081 \
  -e DUAL_READ_ALLOW_PRIVATE_UPSTREAM=true \
  -e DUAL_READ_ADMIN_TOKEN=smoke-admin-token \
  -e DUAL_READ_ALLOW_INSECURE_PUBLIC=true \
  -e DUAL_READ_METRICS_ENABLED=true \
  "${IMAGE}" >/dev/null

echo "[docker-smoke] waiting for /livez..."
ok=0
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/livez" >/dev/null; then
    ok=1
    break
  fi
  sleep 0.5
done
if [[ "${ok}" != "1" ]]; then
  echo "[docker-smoke] /livez failed" >&2
  docker logs "${NAME}" >&2 || true
  exit 1
fi

curl -sf "http://127.0.0.1:${PORT}/readyz" >/dev/null
curl -sf "http://127.0.0.1:${PORT}/metrics" | grep -q dual_read_requests_total

chat_body='{"model":"smoke-model","messages":[{"role":"user","content":"{\"0\":\"hello\"}"}]}'
curl -sf -D "${TMP_DIR}/first.headers" -o "${TMP_DIR}/first.body" \
  -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "${chat_body}"
curl -sf -D "${TMP_DIR}/second.headers" -o "${TMP_DIR}/second.body" \
  -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "${chat_body}"

tr -d '\r' < "${TMP_DIR}/first.headers" | grep -qi '^X-Cache: MISS$'
tr -d '\r' < "${TMP_DIR}/second.headers" | grep -qi '^X-Cache: HIT$'
cmp -s "${TMP_DIR}/first.body" "${TMP_DIR}/second.body"
calls="$(docker exec "${NAME}" wget -qO- http://mock-upstream:8081/calls)"
echo "${calls}" | grep -q '"calls":1'

# Confirm non-root
uid="$(docker exec "${NAME}" id -u)"
if [[ "${uid}" != "10001" ]]; then
  echo "[docker-smoke] expected uid 10001, got ${uid}" >&2
  exit 1
fi

echo "[docker-smoke] ok (livez/readyz/metrics, chat MISS/HIT, uid=${uid}, read-only)"
