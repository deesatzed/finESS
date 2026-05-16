# finESS Handoff Packet

**Generated:** 2026-05-16
**Branch:** `main`
**Commit provenance:** this handoff is part of the final true-preprod readiness commit on `main`; verify the exact commit with `git rev-parse HEAD` after checkout. The exact pushed hash is also reported in the completion summary.
**Working tree:** clean except for stale historical `HANDOFF_2026-05-15.md`, which remains untracked and intentionally preserved.
**Status:** conditional local pre-production beta. Local proofs pass; live OpenRouter provider smoke remains blocked by missing credentials.

## Current Product State

finESS is a local Next.js/Prisma/SQLite beta with Real Data Mode as the primary first-run workflow. Users can paste or upload CSV rows, select a measured target column, set an optional threshold, compute empirical observed-data statistics locally, save the observed result, load it without rerunning simulation, and record calibration outcomes against the saved observed result.

OpenRouter setup is local-config driven. `/api/models` reads configured model options, reports key presence without returning the key, and the UI supports a session-only API-key override. AI Assist is opt-in and sends computed observed-data summary statistics only; raw CSV rows remain local.

True-preprod hardening now adds local-safe audit events for analysis, calibration, access denial, and AI-assist paths, plus a gated live OpenRouter smoke command. Audit metadata intentionally avoids API keys, session tokens, raw CSV rows, and free-text queries.

## Completed Work

| Area | Status | Evidence |
|---|---|---|
| IT-07 ownership | Complete locally | `User`, `Workspace`, `LocalSession`, `Analysis.userId/workspaceId`, `CalibrationOutcome.userId/workspaceId`; guarded API routes and cross-owner tests |
| Real Data Mode | Complete locally | CSV parse/analyze utilities, first-run UI, observed Save/Load, Calibration, E2E workflow |
| OpenRouter model/key UX | Complete locally | Env/config model parser, `/api/models`, session-only key UI, secret non-echo tests |
| AI-assisted observed interpretation | Implemented; live blocked | `/api/real-data/assist`, schema validation, mocked API/E2E tests, live smoke script |
| Local audit events | Complete locally | `AuditEvent` model, `lib/audit/events.ts`, route logging, API tests for audit events and non-secret metadata |
| Release readiness docs | Complete locally | `RELEASE_CHECKLIST.md`, `docs/plans/2026-05-16-true-preprod-goal.md`, updated handoff |
| CI coverage | Updated locally | `.github/workflows/ci.yml` includes `npm run smoke:openrouter` blocked-mode check |

## Verification Results

| Command | Result |
|---|---|
| `npm run check:env` | PASS; `Environment preflight passed` |
| `npm run smoke:openrouter` | PASS in blocked mode; printed `OPENROUTER_LIVE_SMOKE_BLOCKED` without printing secrets |
| `npm test -- --runInBand` | PASS; 16 suites, 128 tests |
| `npm run test:e2e` | PASS; 1 suite, 4 tests |
| `npm run build` | PASS; Next.js production build completed |
| `git grep -n '"custom"' -- lib app components __tests__` | PASS for unsupported-method check; no matches returned |
| `git diff --check` | PASS |
| Local env inspection | `.env.local` has `OPENROUTER_API_KEY:empty`, `OPENROUTER_MODELS:set`, `OPENROUTER_DEFAULT_MODEL:set`, `DATABASE_URL:absent` |

## Browser Smoke Evidence

Safari at `http://127.0.0.1:3100` previously verified the current showpiece path:

- OpenRouter model list showed `OpenRouter Auto` from local env/config.
- Key state showed `No API key active` when `.env.local` had no key.
- Sample CSV loaded locally with 5 rows.
- Target column selected: `outcome`; threshold set: `0.5`.
- Observed result rendered from 4 usable target rows with 1 missing target row: mean `0.7500`, empirical interval `[0.0750, 1.000]`, `P(>50%) = 75.0%`.
- Session-only API-key UX accepted a placeholder key, enabled `AI Assist`, and cleared back to `No API key active`.
- Save succeeded with ID `cmp8lxfj400011yvm1di2ur6j`.
- Load restored the saved observed analysis without rerunning simulation.
- Calibration opened for the saved observed result at predicted probability `75.0%`.
- Recording `It happened` succeeded and advanced calibration progress from `1 / 20` to `2 / 20`.
- The dev server was stopped after smoke; `lsof -iTCP:3100 -sTCP:LISTEN` returned no listener.

Live AI Assist with a real OpenRouter response was not executed because no valid API key is configured in this workspace. `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` is the remaining provider proof once a key is available.

## Environment State

- `.env` contains local SQLite `DATABASE_URL`.
- `.env.local` has no `DATABASE_URL` and has an empty `OPENROUTER_API_KEY`.
- `.env.local` has non-secret model config for `OPENROUTER_MODELS` and `OPENROUTER_DEFAULT_MODEL`.
- No real secrets were printed, committed, or added to tracked files.

## Deferred Production Risks

- Live OpenRouter smoke remains pending until a valid local key is available.
- Hosted deployment remains deferred: real auth provider, HTTPS-only cookie policy, account recovery/admin policy, migration/backfill policy, production secret management, privacy/compliance review, and abuse/rate-limit policy are not implemented.
- Audit events are local SQLite records, not tamper-resistant production audit logs.
- Persistent key storage is intentionally not implemented.
- Real Data Mode supports single-table CSV only; joins, time-series validation splits, model fitting, external connectors, and report/export features remain deferred.
- finESS remains domain-agnostic. It does not provide clinical, legal, financial, engineering, or policy advice.

## Operator Notes

- To complete live OpenRouter smoke, set a valid `OPENROUTER_API_KEY` in `.env.local` or the shell, then run `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter`. Do not paste the key into chat or commit it.
- Start locally with `npm run dev -- -H 127.0.0.1 -p 3100`.
- Real Data Mode is the primary path; the PE simulation remains available as a legacy/demo path.
