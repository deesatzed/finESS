#!/usr/bin/env bash
# Convenience wrapper that exports PYTHONPATH so the editable install of
# ace_hospital (or the cloned worktree path) resolves without polluting
# the user's global site-packages.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"

ACE_PATH="${ACE_HOSPITAL_PATH:-/Volumes/WS4TB/WS4TBr/aXc11426}"

if [ ! -d "$ACE_PATH/ace_hospital" ]; then
    echo "ace_hospital package not found at $ACE_PATH" >&2
    echo "Set ACE_HOSPITAL_PATH to the directory that contains the ace_hospital/ package." >&2
    exit 1
fi

export PYTHONPATH="${ACE_PATH}:${REPO_ROOT}:${PYTHONPATH:-}"
cd "$REPO_ROOT"
exec python3 -m pytest services/ensemble/tests "$@"
