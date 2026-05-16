#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3100}"
DEV_SERVER_PID=""

cleanup() {
  if [[ -n "$DEV_SERVER_PID" ]]; then
    kill "$DEV_SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== Preflight =="
node --version
npm --version
test -f package.json
test -f .env.example

echo "== Environment Check =="
npm run check:env

echo "== Prisma =="
npx prisma generate
npx prisma db push

echo "== Unit and Integration Tests =="
npm test -- --runInBand

echo "== Build =="
npm run build

echo "== Runtime Smoke =="
npm run dev -- -H 127.0.0.1 -p "$PORT" >/tmp/finess-dev.log 2>&1 &
DEV_SERVER_PID=$!

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

curl -fsS "http://127.0.0.1:${PORT}" >/dev/null
curl -fsS "http://127.0.0.1:${PORT}/api/analyses" >/dev/null
curl -fsS "http://127.0.0.1:${PORT}/api/calibration" >/dev/null

echo "== E2E Workflow Tests =="
npm run test:e2e

echo "ALL MITIGATIONS VERIFIED"
