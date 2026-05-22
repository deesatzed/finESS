# GOAL.md

## Outcome

Run a fresh-clone Codex-CAM goal test on finESS by applying one small, local, testable improvement that does not require external services, API keys, or database writes.

## Chosen Improvement

Harden the fresh-clone local setup path so a new user can install dependencies, create/repair local env files, initialize Prisma/SQLite, and run the default offline test suite without external services.

## Root Causes Mitigated

1. Fresh clones do not have dependencies installed, so `npm test` fails with `jest: command not found` until `npm install` is run.
2. A copied CAM `.env` can be valid for CAM but invalid for finESS because it may not declare `DATABASE_URL`.
3. Prisma CLI and Jest need a concrete SQLite schema before API tests can run.
4. Jest/Prisma/Next load env through different paths, so `.env.local` alone does not reliably configure tests.
5. Copied provider credentials can accidentally trigger live Semantic auto-advance during default tests.
6. Test harnesses that intentionally use fake provider keys must still be able to exercise mocked adapter paths without hitting a real provider.

## Proof Of Done

1. Fresh clone exists at `/Volumes/WS4TB/WS4TBr/CAM_Codx/showpiece-clones/finESS-goal-test`.
2. Local runtime inputs are present but ignored by Git:
   - `.env`
   - `.env.local`
   - `data/claw.db`
3. `data/claw.db` hash matches the source CAM database.
4. Focused env-check tests pass:
   - `npm test -- __tests__/scripts/check-env.test.ts --runInBand`
5. Semantic API tests pass with copied provider credentials present but live calls disabled by default:
   - `npm test -- __tests__/api/semantic.test.ts --runInBand`
6. One-command local verification passes:
   - `npm run verify:local`
7. Production build passes:
   - `npm run build`
8. `git diff --check HEAD` is clean.

## Scope

Allowed tracked files:

- `GOAL.md`
- `README.md`
- `jest.config.ts`
- `jest.setup.cjs`
- `lib/semantic/api-env.ts`
- `package.json`
- `scripts/check-env.mjs`
- `scripts/setup-local.mjs`
- `__tests__/scripts/check-env.test.ts`

Ignored local-only files:

- `.env`
- `.env.local`
- `data/claw.db`

## Constraints

- Do not reveal, commit, or print `.env` secrets.
- Keep `.env.local` limited to non-secret local setup values for this clone.
- Do not commit `data/claw.db`.
- Do not use OpenRouter or any external API during verification.
- Do not change finESS application behavior outside local setup/test bootstrap and env preflight parsing.
- Do not weaken existing validations.

## Stop Rules

Stop if verification requires external credentials, generated secrets, destructive cleanup, or a broader rewrite than the selected env preflight hardening.

## Run Log

- Fresh clone was created from `https://github.com/deesatzed/finESS.git` at `/Volumes/WS4TB/WS4TBr/CAM_Codx/showpiece-clones/finESS-goal-test`.
- Copied CAM runtime inputs into the clone:
  - `.env` from `/Volumes/WS4TB/WS4TBr/CAM_Codx/CAM_CAM/.env`
  - `data/claw.db` from `/Volumes/WS4TB/WS4TBr/CAM_Codx/CAM_CAM/data/claw.db`
- Verified `.env`, `.env.local`, `data/claw.db`, and `node_modules` are ignored by Git.
- Verified copied `data/claw.db` hash matches source: `3ee02c52935731e15069e1a895a16f06ed8205b04492b099da2a79ba6bcadd35`.
- First focused test run failed because a fresh clone had no installed Jest binary. Mitigation: ran `npm install`.
- `npm install` completed from the lockfile and reported dependency advisories; no audit-fix was attempted because that is outside this goal.
- `npm test -- __tests__/scripts/check-env.test.ts --runInBand` passed after the parser change.
- `npm run check:env` initially failed because the copied CAM `.env` is not a finESS app env and does not contain `DATABASE_URL`. Mitigation: added ignored non-secret `.env.local` with `DATABASE_URL=file:./dev.db`.
- `npm run check:env` passed after `.env.local` was added.
- Broader baseline check `npm test -- --runInBand` did not pass: 61 suites passed, 2 failed, 13 skipped. Failures were in `__tests__/api/forecast.test.ts` and `__tests__/api/semantic.test.ts`.
- Mitigation for API tests: ran `DATABASE_URL=file:./dev.db npx prisma db push --skip-generate`, then reran `DATABASE_URL=file:./dev.db npm test -- __tests__/api/forecast.test.ts __tests__/api/semantic.test.ts --runInBand`.
- After Prisma schema sync, `__tests__/api/forecast.test.ts` passed and `__tests__/api/semantic.test.ts` still failed with existing state-machine expectations receiving `ERROR` instead of `CLARIFYING`.
- Root cause: the copied CAM `.env`/`.env.local` can contain provider credentials. Default Jest runs were accidentally taking the live Semantic auto-advance path. Mitigation: added `jest.setup.cjs`, wired it through `jest.config.ts`, and force provider keys to empty strings unless explicit live-test flags are set.
- Added `scripts/setup-local.mjs` and `npm run setup:local` so new clones can create/repair local env files and sync Prisma/SQLite without guessing.
- Added `npm run verify:local` as the one-command offline new-user verification gate.
- First `verify:local` run after the broad Jest env mitigation failed in `__tests__/scripts/preflight-models.test.ts` because clearing provider keys globally broke child-process fixture env. Fix: removed global provider-key clearing from Jest setup and moved the default-offline rule into Semantic API env resolution.
- Second `verify:local` run failed in `__tests__/api/semantic-research-event.test.ts` because that test retained a real copied provider key via `process.env.OPENROUTER_API_KEY || "test-key"`. Fix: make the test force `test-key`, and let Semantic API env resolution accept only fake `test-*` / `sk-test-*` keys during default Jest runs.
- Final `npm run verify:local` passed: 63 suites passed, 13 skipped; 963 tests passed, 25 skipped.
- `npm run build` passed with Next.js production build output for 13 app routes.

## Remaining Baseline Risk

The local setup/test root causes are mitigated in this clone. Live provider and sidecar paths still require explicit credentials/services and are intentionally outside the offline new-user gate.
