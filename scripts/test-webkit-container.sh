#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

PLAYWRIGHT_VERSION=$(node -e "console.log(require('@playwright/test/package.json').version)")
IMAGE="${E2E_COL_WEBKIT_IMAGE:-mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble}"
TOY_PORT="${E2E_COL_TEST_TOY_PORT:-28217}"
WEB_PORT="${E2E_COL_TEST_WEB_PORT:-4274}"

for port in "$TOY_PORT" "$WEB_PORT"; do
  if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "invalid TCP port: $port" >&2
    exit 2
  fi
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for reproducible local WebKit qualification" >&2
  exit 3
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is unavailable" >&2
  exit 3
fi

require_free_port() {
  local port=$1
  node -e "const net=require('node:net'); const s=net.createServer(); s.once('error',()=>process.exit(1)); s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))" || {
    echo "TCP port ${port} is already in use; set E2E_COL_TEST_TOY_PORT/E2E_COL_TEST_WEB_PORT" >&2
    exit 4
  }
}
require_free_port "$TOY_PORT"
require_free_port "$WEB_PORT"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "pulling $IMAGE" >&2
  docker pull "$IMAGE"
fi

workdir=$(mktemp -d "${TMPDIR:-/tmp}/e2e-col-webkit.XXXXXX")
toy_log="$workdir/toy.log"
web_log="$workdir/web.log"
toy_pid=''
web_pid=''
cleanup() {
  if [[ -n "$web_pid" ]]; then kill "$web_pid" 2>/dev/null || true; fi
  if [[ -n "$toy_pid" ]]; then kill "$toy_pid" 2>/dev/null || true; fi
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

wait_url() {
  local url=$1
  local label=$2
  local pid=$3
  for _ in $(seq 1 100); do
    if curl --silent --fail --max-time 1 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label exited before becoming ready" >&2
      return 1
    fi
    sleep 0.1
  done
  echo "timed out waiting for $label at $url" >&2
  return 1
}

TOY_SIGNAL_CLI_PORT="$TOY_PORT" pnpm --filter @e2e-col/toy-signal-cli dev >"$toy_log" 2>&1 &
toy_pid=$!
wait_url "http://127.0.0.1:${TOY_PORT}/api/v1/check" "toy Signal service" "$toy_pid" || {
  cat "$toy_log" >&2
  exit 1
}

VITE_E2E_COL_IDENTITY_URL="http://127.0.0.1:${TOY_PORT}" \
VITE_E2E_COL_MOCK_SIGNAL_URL="ws://127.0.0.1:${TOY_PORT}/api/v1/messages" \
  pnpm --filter @e2e-col/web build

pnpm --filter @e2e-col/web exec vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$web_log" 2>&1 &
web_pid=$!
wait_url "http://127.0.0.1:${WEB_PORT}" "web preview" "$web_pid" || {
  cat "$web_log" >&2
  exit 1
}

docker run --rm \
  --network host \
  --ipc=host \
  --user "$(id -u):$(id -g)" \
  -e CI=1 \
  -e HOME=/tmp/pw-home \
  -e E2E_COL_TEST_REUSE_SERVERS=1 \
  -e E2E_COL_TEST_TOY_PORT="$TOY_PORT" \
  -e E2E_COL_TEST_WEB_PORT="$WEB_PORT" \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  --tmpfs /tmp/pw-home:rw,exec,nosuid,nodev \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" \
  node node_modules/@playwright/test/cli.js test --config playwright.config.ts --project=webkit
