#!/usr/bin/env bash
# Convenience wrapper that runs the gated R6-06 calibration-loop integration
# test against the live ensemble sidecar. Mirrors the pattern documented in
# the test file's docstring; collected here so the test gate can be flipped
# without re-typing the env vars every time.
#
# Prerequisite: `docker compose up -d ensemble` and a healthy sidecar at
# ENSEMBLE_SIDECAR_URL (defaults to http://localhost:8001).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

export RUN_ENSEMBLE_INTEGRATION=1
export ENSEMBLE_SIDECAR_URL="${ENSEMBLE_SIDECAR_URL:-http://localhost:8001}"

cd "$REPO_ROOT"
exec npx jest --runInBand __tests__/integration/calibration-loop.integration.test.ts "$@"
