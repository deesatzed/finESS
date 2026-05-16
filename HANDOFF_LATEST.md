# finESS Handoff Packet

**Generated:** 2026-05-16
**Branch:** `main`
**Current commit:** `609140ae277a67fcbf2b5a4be8a103641aaec34b` (`609140a`)
**Working tree:** dirty with intentional local IT-07, Real Data Mode, OpenRouter model/key, AI-assist, tests, and handoff updates. Stale historical `HANDOFF_2026-05-15.md` remains untracked and intentionally preserved.
**Status:** pre-production local beta implementation is in place, but live OpenRouter AI-assist browser success is blocked until a valid local key is configured or entered in-session.

## Current Product State

finESS is a local Next.js/Prisma/SQLite beta with Real Data Mode as the primary first-run workflow. Users can paste or upload CSV rows, select a measured target column, set an optional threshold, compute empirical observed-data statistics locally, save the observed result, load it without rerunning simulation, and record calibration outcomes against the saved observed result.

OpenRouter setup is now local-config driven. `/api/models` reads `OPENROUTER_MODELS` plus `OPENROUTER_DEFAULT_MODEL`/`OPENROUTER_MODEL`, returns model IDs/labels/default metadata, and reports key presence without returning the key. The UI shows the configured models, shows key state, and supports a session-only OpenRouter key override that is not stored in tracked files.

AI Assist is opt-in from an observed-data result. It sends only computed summary statistics, target label, row count, missingness count, threshold, and selected model to OpenRouter. Raw CSV rows remain local. Local empirical calculations remain authoritative, and AI interpretation is rendered separately.

## Assumptions Recorded

- Local SQLite remains the target runtime.
- Runtime API keys are session/browser-memory only. No persistent key storage was added.
- OpenRouter may interpret computed observed-data summaries but must not replace local empirical calculations.
- `.env.local` currently has `OPENROUTER_API_KEY` empty, `OPENROUTER_MODELS` set, `OPENROUTER_DEFAULT_MODEL` set, and no `DATABASE_URL`.
- Live OpenRouter success cannot be honestly verified in this workspace until a valid key is configured locally or entered in the UI.

## Completed Work

| Area | Status | Files |
|---|---|---|
| IT-07 ownership | Complete locally | `prisma/schema.prisma`, `lib/auth/*`, `app/api/auth/local/route.ts`, guarded analyses/calibration routes, ownership tests |
| Real Data Mode | Complete locally | `components/RealDataPanel.tsx`, `lib/real-data/csv.ts`, `lib/real-data/analyze.ts`, E2E tests |
| OpenRouter model config | Complete locally | `lib/ai/model-config.ts`, `app/api/models/route.ts`, `.env.example`, model-config tests |
| Session API-key setup | Complete locally | `components/ModelSelector.tsx`, `app/api/analyze/route.ts`, validation/tests |
| AI-assisted observed interpretation | Implemented, mocked tests pass | `app/api/real-data/assist/route.ts`, `lib/real-data/assist.ts`, API/E2E tests |
| Save/Load observed restore | Complete locally | `components/SaveLoadModal.tsx`, `lib/ui/compact-result.ts`, E2E/browser smoke |
| Calibration observed outcome | Complete locally | `components/CalibrationModal.tsx`, `app/api/calibration/route.ts`, E2E/browser smoke |

## Verification Results

| Command | Result |
|---|---|
| `npm run check:env` | PASS; `Environment preflight passed`; `.env.local` does not provide `DATABASE_URL` |
| `npm test -- --runInBand` | PASS; 16 suites, 128 tests |
| `npm run test:e2e` | PASS; 1 suite, 4 workflow tests |
| `npm run build` | PASS; Next.js production build completed and includes `/api/real-data/assist` |
| `git grep -n '"custom"' -- lib app components __tests__` | PASS for unsupported-method check; no matches returned |
| `npm test -- --runInBand __tests__/ai/model-config.test.ts __tests__/api/routes.test.ts __tests__/real-data/analyze.test.ts __tests__/real-data/assist.test.ts __tests__/e2e/workflow.test.ts __tests__/ui/analysis-status.test.ts` | PASS; 6 suites, 33 tests |
| `npm run build` | PASS; Next.js production build completed and includes `/api/real-data/assist` |
| `node` local env inspection | `.env.local` has `OPENROUTER_API_KEY:empty`, `OPENROUTER_MODELS:set`, `OPENROUTER_DEFAULT_MODEL:set`, `DATABASE_URL:absent` |
| `git diff --check` | PASS after removing Markdown trailing whitespace |

## Browser Smoke Evidence

Safari at `http://127.0.0.1:3100` verified the current showpiece path:

- App loaded from a clean dev server on port `3100`.
- OpenRouter model list showed `OpenRouter Auto` from local env/config.
- Key state showed `No API key active` when `.env.local` had no key.
- Sample CSV loaded locally: `id,outcome,score` with 5 rows.
- Target column selected: `outcome`.
- Threshold set: `0.5`.
- Observed result rendered from 4 usable target rows with 1 missing target row: mean `0.7500`, empirical interval `[0.0750, 1.000]`, `P(>50%) = 75.0%`.
- Session-only API-key UX accepted a placeholder key, changed state to `Session API key active; not stored`, enabled `AI Assist`, and cleared back to `No API key active`.
- Save succeeded with ID `cmp8lxfj400011yvm1di2ur6j`.
- Load restored the saved observed analysis without rerunning simulation.
- Calibration opened for the saved observed result at predicted probability `75.0%`.
- Recording `It happened` succeeded and advanced calibration progress from `1 / 20` to `2 / 20`.
- The dev server was stopped after smoke; `lsof -iTCP:3100 -sTCP:LISTEN` returned no listener.

Live AI Assist with a real OpenRouter response was not executed because no valid API key is configured in this workspace. Mocked API and E2E tests verify request shape, secret non-echoing, and response rendering path.

## Environment State

- `.env` contains local SQLite `DATABASE_URL`.
- `.env.local` has no `DATABASE_URL` and has an empty `OPENROUTER_API_KEY`.
- `.env.local` has non-secret model config for `OPENROUTER_MODELS` and `OPENROUTER_DEFAULT_MODEL`.
- No real secrets were printed, committed, or added to tracked files.

## Deferred Production Risks

- Hosted deployment remains deferred: auth provider choice, HTTPS-only cookies, account recovery/admin policy, migration/backfill policy, production secret management, privacy/compliance review, and abuse/rate-limit policy are not implemented.
- Live OpenRouter smoke remains pending until a valid local key is available.
- Persistent key storage is intentionally not implemented.
- `IT-12` structured audit/observability events remain deferred.
- `PERF-01` simulation performance guardrails remain deferred.
- Real Data Mode supports single-table CSV only; joins, time-series validation splits, model fitting, external connectors, and report/export features remain deferred.
- finESS remains domain-agnostic. It does not provide clinical, legal, financial, engineering, or policy advice.

## Local Changed Files

Intentional local changes include:

- `.env.example`
- `HANDOFF_LATEST.md`
- `app/api/analyses/[id]/route.ts`
- `app/api/analyses/route.ts`
- `app/api/analyze/route.ts`
- `app/api/auth/local/route.ts`
- `app/api/calibration/route.ts`
- `app/api/models/route.ts`
- `app/api/real-data/assist/route.ts`
- `app/page.tsx`
- `components/AnalysisStatusStrip.tsx`
- `components/CalibrationModal.tsx`
- `components/ModelSelector.tsx`
- `components/NarrationStream.tsx`
- `components/RealDataPanel.tsx`
- `components/SaveLoadModal.tsx`
- `components/panels/LiveDistribution.tsx`
- `components/panels/SpectrumBars.tsx`
- `docs/plans/2026-05-16-real-data-mode-design.md`
- `lib/ai/model-config.ts`
- `lib/auth/client.ts`
- `lib/auth/local-session.ts`
- `lib/real-data/analyze.ts`
- `lib/real-data/assist.ts`
- `lib/real-data/csv.ts`
- `lib/types.ts`
- `lib/ui/analysis-status.ts`
- `lib/ui/compact-result.ts`
- `lib/validation/schemas.ts`
- `prisma/schema.prisma`
- `__tests__/ai/model-config.test.ts`
- `__tests__/api/routes.test.ts`
- `__tests__/e2e/workflow.test.ts`
- `__tests__/real-data/analyze.test.ts`
- `__tests__/real-data/assist.test.ts`
- `__tests__/real-data/csv.test.ts`
- `__tests__/ui/analysis-status.test.ts`
- `__tests__/ui/compact-result.test.ts`

## Operator Notes

- To complete live OpenRouter smoke, set a valid `OPENROUTER_API_KEY` in `.env.local` or enter it in the session-only UI field. Do not paste the key into chat or commit it.
- Start locally with `npm run dev -- -H 127.0.0.1 -p 3100`.
- Real Data Mode is the primary path; the PE simulation remains available as a legacy/demo path.
