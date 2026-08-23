#!/usr/bin/env bash
set -euo pipefail

TOY_PORT="${DOCS_CAPTURE_TOY_PORT:-28185}"
WEB_PORT="${DOCS_CAPTURE_WEB_PORT:-41991}"
LOG_DIR=".wsbridge/docs-capture"
mkdir -p "$LOG_DIR"

TOY_SIGNAL_CLI_PORT="$TOY_PORT" pnpm --filter @e2e-col/toy-signal-cli dev > "$LOG_DIR/toy.log" 2>&1 &
toy_pid=$!
(
  VITE_E2E_COL_IDENTITY_URL="http://127.0.0.1:${TOY_PORT}" \
  VITE_E2E_COL_MOCK_SIGNAL_URL="ws://127.0.0.1:${TOY_PORT}/api/v1/messages" \
  pnpm --filter @e2e-col/web build && \
  pnpm --filter @e2e-col/web exec vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort
) > "$LOG_DIR/web.log" 2>&1 &
web_pid=$!

cleanup() {
  kill "$toy_pid" "$web_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${TOY_PORT}/api/v1/check" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${WEB_PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:${TOY_PORT}/api/v1/check" >/dev/null
curl -fsS "http://127.0.0.1:${WEB_PORT}" >/dev/null

DOCS_CAPTURE_BASE_URL="http://127.0.0.1:${WEB_PORT}" \
DOCS_CAPTURE_TOY_URL="http://127.0.0.1:${TOY_PORT}" \
node scripts/capture-poc-screenshots.mjs

sha256sum docs/assets/poc-e2e-*.png
