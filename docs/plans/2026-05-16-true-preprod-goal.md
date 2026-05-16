# True Pre-Production Goal

```text
/goal
OUTCOME: Bring finESS from verified local beta to true pre-production readiness by adding local-safe audit evidence, gated live OpenRouter verification, release-readiness documentation, and an updated handoff that clearly separates implemented controls from blocked or deferred production risks.

PROOF OF DONE:
1. Run `npm run check:env` and confirm it exits 0.
2. Run `npm test -- --runInBand` and confirm it exits 0.
3. Run `npm run test:e2e` and confirm it exits 0.
4. Run `npm run build` and confirm it exits 0.
5. Run `git diff --check` and confirm it is clean.
6. Run `git grep -n '"custom"' -- lib app components __tests__` and confirm no unsupported `custom` method is accepted.
7. Run `npm run smoke:openrouter` with no key and confirm it does not print secrets and reports the missing-key blocker.
8. If a valid `OPENROUTER_API_KEY` is configured locally, run `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` and confirm it exits 0.
9. Inspect `RELEASE_CHECKLIST.md` and `HANDOFF_LATEST.md` and confirm they list current branch/commit, dirty state, verification evidence, live-provider blocker if any, release decision, rollback plan, and deferred production risks.
10. Commit and push intentional changes to GitHub, then verify `origin/main` points to the pushed commit.

SCOPE:
- Modify only: `app/`, `components/`, `lib/`, `__tests__/`, `prisma/`, `scripts/`, `.github/workflows/`, `docs/`, `HANDOFF_LATEST.md`, `RELEASE_CHECKLIST.md`, `package.json`, `package-lock.json`, `.env.example`, `.gitignore`.
- Read/reference: current API routes, auth/session helpers, validation helpers, OpenRouter route code, CI workflow, handoff, and real-data design docs.
- Do not modify: real secrets, `.env` values, `.env.local` secrets, `node_modules/`, `.next/`, `coverage/`, stale historical handoff artifacts, deployment hosting config, git history, or remotes.

CONSTRAINTS:
- Do not store API keys, session tokens, raw CSV rows, PHI, or sensitive input data in audit events.
- Do not make live OpenRouter smoke mandatory in CI unless a safe secret is explicitly configured.
- Do not weaken local ownership guards, safe API errors, validation, Save/Load, Calibration, or unsupported-method rejection.
- Do not implement hosted auth, billing, public deployment, compliance claims, or production secret management.
- Do not add dependencies unless necessary and justified.
- Preserve Real Data Mode as the primary path and keep local empirical calculations authoritative.

SAFETY / PROVENANCE:
- Treat owner/workspace isolation as a security boundary.
- Separate observed facts, computed statistics, AI interpretation, and deferred production capability.
- Do not add domain-specific recommendations, clinical thresholds, legal advice, financial advice, or new decision rules.
- Document blocked live-provider verification honestly when no valid key is available.

ITERATION:
1. Inspect current status and confirm the previous local beta commit is pushed.
2. Add audit event persistence for analysis save/load/delete, calibration read/write, AI assist, and ownership/unauthenticated denials.
3. Add tests proving audit events exist and do not contain secrets or raw CSV.
4. Add a gated live OpenRouter smoke command and npm script.
5. Add release checklist and update handoff with exact command results.
6. Run the full proof suite.
7. Commit and push only intentional files.

STOP:
Pause and summarize if:
- A valid OpenRouter API key is required for live smoke and is not available locally.
- Required verification cannot be run.
- The same failure persists after 3 distinct repair attempts.
- The needed change requires persistent secret storage, hosted auth/provider choice, production deployment, PHI handling, billing, legal/compliance decisions, or destructive database reset.
- The change would violate scope or weaken existing mitigations.

COMPLETE:
Mark complete only when every local proof passes, live OpenRouter smoke either passes with a valid local key or is documented as blocked by missing credentials, `RELEASE_CHECKLIST.md` and `HANDOFF_LATEST.md` are truthful, the commit is pushed to GitHub, `origin/main` is verified, and no real secrets are exposed.
```
