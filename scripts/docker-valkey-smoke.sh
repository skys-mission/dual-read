#!/usr/bin/env bash
# Acceptance smoke for the Compose Valkey profile and L2 cache persistence.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${COMPOSE_PROJECT_NAME:-dual-read-valkey-smoke-$$}"
PORT="${PORT:-$((20000 + ($$ % 20000)))}"
TMP_DIR="$(mktemp -d)"
COMPOSE=(docker compose -f "${ROOT_DIR}/server/docker-compose.yml" --profile valkey --profile test)

export COMPOSE_PROJECT_NAME="${PROJECT}"
export OPENAI_API_KEY="sk-valkey-smoke"
export OPENAI_BASE_URL="http://mock-upstream:8081"
export DUAL_READ_ALLOW_PRIVATE_UPSTREAM="true"
export DUAL_READ_ADMIN_TOKEN="valkey-smoke-admin"
export DUAL_READ_CACHE_VALKEY="true"
export DUAL_READ_PUBLISH_PORT="${PORT}"

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "[docker-valkey-smoke] starting Compose stack on :${PORT}..."
"${COMPOSE[@]}" up -d --build

wait_ready() {
  local expected="${1:-200}"
  for _ in $(seq 1 60); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/readyz" || true)"
    if [[ "${status}" == "${expected}" ]]; then
      return 0
    fi
    sleep 0.5
  done
  echo "[docker-valkey-smoke] expected /readyz=${expected}, got ${status:-none}" >&2
  "${COMPOSE[@]}" logs dual-read-server >&2 || true
  return 1
}

wait_ready 200

chat_body='{"model":"smoke-model","messages":[{"role":"user","content":"{\"0\":\"hello\"}"}]}'
request_chat() {
  local name="$1"
  curl -sf -D "${TMP_DIR}/${name}.headers" -o "${TMP_DIR}/${name}.body" \
    -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "${chat_body}"
}

assert_cache() {
  local name="$1"
  local outcome="$2"
  tr -d '\r' < "${TMP_DIR}/${name}.headers" | grep -qi "^X-Cache: ${outcome}$"
}

request_chat first
request_chat second
assert_cache first MISS
assert_cache second HIT

echo "[docker-valkey-smoke] restarting server to clear L1..."
"${COMPOSE[@]}" restart dual-read-server >/dev/null
wait_ready 200
request_chat after-restart
assert_cache after-restart HIT
cmp -s "${TMP_DIR}/first.body" "${TMP_DIR}/after-restart.body"

calls="$("${COMPOSE[@]}" exec -T dual-read-server wget -qO- http://mock-upstream:8081/calls)"
echo "${calls}" | grep -q '"calls":1'

echo "[docker-valkey-smoke] interrupting and restoring Valkey..."
"${COMPOSE[@]}" stop valkey >/dev/null
wait_ready 503
"${COMPOSE[@]}" start valkey >/dev/null
wait_ready 200

"${COMPOSE[@]}" exec -T dual-read-server test -f /app/data/runtime.json
"${COMPOSE[@]}" exec -T dual-read-server test -f /app/data/secrets.json

echo "[docker-valkey-smoke] ok (MISS/HIT, L2 survives server restart, Valkey readiness recovers)"
