# finESS Release Checklist

## Release Scope

Scope is local pre-production beta readiness for finESS Real Data Mode:

- Local SQLite runtime with authenticated local owner/workspace isolation.
- Real CSV observed-data analysis as the primary path.
- Save/Load and Calibration for observed analyses.
- Env-configured OpenRouter model selection.
- Session-only OpenRouter API-key setup.
- Gated AI Assist for observed summaries.
- Local-safe audit events for sensitive analysis, calibration, and AI-assist API paths.
- Repeatable verification commands and CI coverage.

This is not a hosted production release.

## Go / No-Go Decision

**Conditional Go for local pre-production beta.**

Local app behavior, ownership guards, deterministic tests, E2E workflows, build, local-safe audit events, and non-secret OpenRouter smoke-blocker behavior are implemented and locally verified. Live OpenRouter provider verification is still a **No-Go item for true pre-production sign-off** until a valid local key is configured and `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` exits 0.

## Checklist

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Build | Go | `npm run build` passed | Next.js production build completed |
| Tests | Go | `npm test -- --runInBand` passed; `npm run test:e2e` passed | 16 Jest suites / 128 tests; 4 E2E workflow tests |
| Lint/Typecheck | Go | Next build typecheck passed | No separate lint proof required by current goal |
| Security | Conditional Go | IT-07 owner/workspace guards; audit events | Hosted auth still deferred |
| Privacy | Conditional Go | AI Assist sends summary stats only; audit omits API keys/raw CSV | Live provider call must be opt-in |
| Environment Variables | Go | `npm run check:env` passed; `.env.local` inspection | Empty `DATABASE_URL` in `.env.local` is rejected |
| Documentation | Go | `HANDOFF_LATEST.md`, `docs/plans/2026-05-16-true-preprod-goal.md` | Live OpenRouter blocker is documented |
| Error Handling | Conditional Go | API tests cover stable error envelopes | OpenRouter upstream body is not echoed |
| Logging / Audit | Conditional Go | `AuditEvent` model and route tests | Audit stores metadata only, not secrets/raw CSV |
| CI | Conditional Go | `.github/workflows/ci.yml` includes env check, smoke blocker, Prisma, Jest, E2E, build | Remote CI must be checked after push |
| Rollback | Go | Revert latest commit or reset DB schema from Git | Local SQLite data may require manual migration/backfill |

## Known Blockers

- `.env.local` currently has `OPENROUTER_API_KEY` empty.
- Live OpenRouter smoke is blocked until a valid local key is configured.
- GitHub CLI auth token is invalid locally, though `git push` works.

## Accepted Risks

- Local-only session auth is acceptable for the current beta but not for shared hosting.
- Audit events are local SQLite records, not tamper-resistant production audit logs.
- Runtime API key is memory/session-only by design and disappears on reload.
- Real Data Mode supports single-table CSV only.

## Required Fixes Before True Pre-Prod Sign-Off

1. Configure a valid local OpenRouter key without committing or printing it.
2. Run `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` and confirm exit 0.
3. Browser-smoke AI Assist with a real key and verify the response renders while local empirical stats remain authoritative.
4. Push the final commit and verify `origin/main`.
5. Check GitHub Actions for the pushed commit.

## Deferred Before Hosted Production

- Hosted auth provider selection and integration.
- HTTPS-only cookie deployment policy.
- Account recovery/admin policy.
- Production secret management and rotation.
- Compliance/privacy review for sensitive inputs.
- Structured tamper-resistant audit export or append-only audit sink.
- Abuse/rate-limit policy for AI-provider calls.

## Rollback Plan

- Code rollback: `git revert <preprod-commit>` and push.
- Local database rollback: stop the app, back up `prisma/dev.db`, then run the schema from the reverted commit with `npx prisma db push`.
- Runtime rollback: unset `OPENROUTER_LIVE_SMOKE`, clear session API keys by reloading the browser, and remove any local non-secret model overrides if needed.

## Secret Hygiene

- Rotate `OPENROUTER_API_KEY` on any suspicion of transcript exposure, screenshot leak, shared session, or accidental terminal printout. Revoke the suspect key in the OpenRouter dashboard before generating its replacement.
- After rotation, run `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` and confirm `OPENROUTER_LIVE_SMOKE_OK`.
- Never paste the key into chat, issue trackers, commit messages, PR bodies, or screenshots. The key lives only in `.env.local`, which is gitignored.
- Periodically verify no provider key is in tracked files: `git grep -nE "sk-or-v1-[A-Za-z0-9]{20,}" -- ':!node_modules' ':!.next'` must return nothing. The 20+ character minimum excludes placeholder examples like `sk-or-v1-your-key-here`.
