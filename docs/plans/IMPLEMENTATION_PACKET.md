# IMPLEMENTATION_PACKET.md

## Task Being Attempted

Implement the local-only UX and IT mitigation plan in `docs/plans/2026-05-16-finess-ux-it-mitigation-plan.md`.

## Actual User Goal

Move finESS from local prototype to verified single-user beta: guarded runtime env, local Save/Load and Calibration workflows, rejected unsupported graph methods, guided first-run UX, clear analysis lifecycle, API/CI/E2E verification, and a truthful `HANDOFF_LATEST.md`.

## Files Expected To Change

| File | Expected Change | Risk |
|---|---|---|
| `.env.local` | Remove empty `DATABASE_URL` only if present | Low; local non-secret cleanup |
| `.env.example` | Clarify empty `DATABASE_URL` is invalid in `.env.local` | Low |
| `package.json` | Add verification scripts | Medium |
| `scripts/*` | Add env and mitigation verification scripts | Medium |
| `lib/types.ts` | Remove unsupported `custom` edge method | Medium |
| `lib/ai/*` | Reject unsupported methods and reuse schema validation | Medium |
| `lib/validation/*` | Add local runtime validation helpers | Medium |
| `app/api/*` | Add stable validation and safe errors | Medium |
| `app/page.tsx` | Wire guided UX, lifecycle, Save/Calibration flow | Medium |
| `components/*` | Add or refine first-run, status, modal, responsive/accessibility UX | Medium |
| `__tests__/*` | Add env, parser, API, schema, and workflow tests | Medium |
| `.github/workflows/ci.yml` | Add CI verification | Low |
| `.gitignore` | Ignore local test DB and root prototype artifacts if needed | Low |
| `docs/plans/*` | Track packet/plan progress if needed | Low |
| `HANDOFF_LATEST.md` | Replace stale state with verified mitigation facts | Medium |

## Existing Patterns To Follow

- Next.js 14 App Router API routes under `app/api`.
- Local SQLite via Prisma 6 with `.env` holding `DATABASE_URL`.
- Client-side Monte Carlo and existing `useSimulation` lifecycle.
- Existing Jest with `ts-jest` and `moduleNameMapper` aliases.
- Existing UI style: dark operational dashboard, compact controls, no broad redesign.

## Assumptions

- Local SQLite remains the target runtime.
- Hosted auth and tenant isolation are deferred for this goal.
- No real OpenRouter key is required for PE demo, tests, build, CI, or local workflow verification.
- Existing uncommitted Save/Load, Calibration, and FirstRun files are user/workspace state to preserve and verify, not revert.

## Non-Goals For This Pass

- No hosted auth, billing, public sharing, or deployment.
- No domain-specific clinical, legal, financial, or policy recommendations.
- No broad redesign beyond the mitigation IDs.
- No dependency additions unless the existing toolchain cannot cover the verification requirement.

## Step-by-Step Plan

1. Add failing tests for env guard and unsupported `custom` method, then implement minimal fixes.
2. Add shared validation helpers and API integration tests before tightening route behavior.
3. Refine Save/Load, Calibration, first-run, model setup, and analysis lifecycle UX around existing components.
4. Add CI, local verification script, and E2E workflow tests using the available Jest/Next stack unless Playwright is already available or necessary.
5. Clean scoped repo-root artifacts by ignoring or moving only allowed prototype files.
6. Update `HANDOFF_LATEST.md` with current branch/commit, dirty state, completed mitigation IDs, command results, and deferred risks.
7. Run all proof-of-done commands and `git diff --check`.

## Acceptance Criteria

- `./scripts/verify-mitigations.sh` exits 0 and prints `ALL MITIGATIONS VERIFIED`.
- `npm test -- --runInBand`, `npm run build`, and `npm run check:env` exit 0.
- Empty `DATABASE_URL` in `.env.local` is rejected, and the local file no longer contains that empty entry.
- No unsupported `"custom"` edge method remains accepted in app/lib/component/test code.
- CI, API integration tests, E2E workflow tests, and master verification script exist.
- `HANDOFF_LATEST.md` truthfully reflects verified state and deferred hosted/multi-user risks.
- `git diff --check` is clean.

## Verification Plan

- Run focused tests after each batch.
- Run API route integration tests against a test SQLite database.
- Run a local dev server smoke check through the verification script.
- Run final proof commands exactly as requested.

## Rollback Plan

- Revert changed files in the relevant batch only.
- Restore previous API behavior only if validation causes a verified regression.
- Keep local `.env.local` secret values untouched; only remove an empty `DATABASE_URL` line.

## Risks

| Risk | Mitigation |
|---|---|
| Existing dirty files may include prior user work | Read and integrate; do not revert |
| E2E dependency install may be blocked | Prefer Jest-based workflow tests unless Playwright is necessary and available |
| API tests may touch dev DB | Use test DB path and reset only that DB |
| Hosted safety scope may drift | Document `IT-07` as deferred and keep local-only framing |

## Proceed / Block Decision

Proceed. No blocker found in the plan; the current empty `.env.local` `DATABASE_URL` is a direct mitigation target.
