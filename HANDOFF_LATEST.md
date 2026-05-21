# finESS — Handoff Packet
**Generated:** 2026-05-21T18:30Z  
**Branch:** `main` @ `518f509`  
**Last Commit:** 2026-05-21 — `docs: update handoff for P3 completion`

---

## Quick Resume Checklist
- [ ] `git fetch && git checkout main && git pull` (HEAD should be `518f509`)
- [ ] `cp .env.example .env && cp .env.example .env.local` (set `OPENROUTER_API_KEY`, optionally `TAVILY_API_KEY`)
- [ ] `npm install`
- [ ] `npx prisma generate && npx prisma db push --skip-generate`
- [ ] `npm run check:env` → `Environment preflight passed`
- [ ] `npm test -- --runInBand` → `63 suites passed (13 skipped), 962 passed, 25 skipped, 987 total`
- [ ] `npm run build` → `Compiled successfully`
- [ ] `npm run lint` → `No ESLint warnings or errors`
- [ ] Review **Current State Assessment** and **Next Steps** sections

## AI Continuity Checklist
- [x] Latest handoff reviewed (`HANDOFF_2026-05-21.md` — this packet supersedes all prior)
- [x] Open assumptions imported — none outstanding
- [x] Open debt items imported — RAG integration tests gated (known, acceptable)
- [x] Open error references imported — none
- [x] Verification suite executed at handoff time (results below are measured)
- [x] Next actions prioritized — no outstanding planned work; all P0–P3 complete

---

## What This Project Does

finESS is a **local Next.js + Prisma/SQLite uncertainty workbench**. A single operator on their own machine builds probabilistic models in one of five user-facing modes: Semantic (multi-turn conversation → research → Monte Carlo), Forecast (time-series CSV + Python ensemble), Real Data (empirical CSV stats), Multi-LLM Proposer, and Path A Simulation. The distinguishing feature is **honest uncertainty**: every number has a distribution, every distribution has a provenance chain, and every result comes with a calibrated spread rather than a point estimate.

**Tech Stack:** TypeScript (Next.js 14.2.35 App Router), React 18, Prisma 6.19 / SQLite, Python 3.11 / FastAPI sidecar, OpenRouter for LLMs, Tavily for web search, `@xenova/transformers` BGE + `@lancedb/lancedb` for RAG, Jest for tests, Docker Compose for the sidecar.

**Architecture Pattern:** Monolith Next.js app + detached Python sidecar (Docker). No auth server, no cloud dependency — runs fully local.

---

## Project Structure

```
finESS/
├── app/                        Next.js App Router pages + API routes
│   ├── api/
│   │   ├── analyze/            Path A + Multi-LLM Proposer endpoints
│   │   ├── calibration/        Brier score + reliability + EMA feedback
│   │   ├── forecast/           Time-series → ensemble sidecar proxy
│   │   ├── real-data/          CSV upload + LLM narration
│   │   └── semantic/           Full Semantic Mode API (CRUD + events + export)
│   │       └── [id]/export/    GET ?format=json|md export endpoint (D3)
│   └── page.tsx                Single-page dashboard shell
├── components/
│   ├── semantic/               ClarificationStep, ComponentReviewStep,
│   │                           ThresholdStep, ResearchStep, ResultStep,
│   │                           SemanticHistory, SemanticHonestyBanner
│   ├── panels/                 Individual Dashboard cockpit panels
│   ├── SemanticPanel.tsx       Top-level Semantic Mode container
│   ├── Dashboard.tsx           6-panel cockpit host
│   └── CalibrationModal.tsx    Reliability + Brier canvas rendering
├── lib/
│   ├── semantic/
│   │   ├── state-machine.ts    Pure reducer: 12 states, all events
│   │   ├── auto-advance.ts     Server-side LLM dispatch + MODELING MC
│   │   ├── bundle-to-node.ts   ResearchBundle → UncertaintyNode (D1)
│   │   ├── export.ts           Conversation → JSON / Markdown (D3)
│   │   ├── persistence.ts      Prisma CRUD for SemanticConversation
│   │   ├── research/           7 research mechanism adapters (B1–B7)
│   │   ├── narration.ts        Human-readable event narration
│   │   └── types.ts            SemanticMode-specific types
│   ├── engine/
│   │   ├── monte-carlo.ts      runSimulation() — 10k sample MC
│   │   └── sensitivity.ts      computeSensitivity() — variance reduction
│   ├── ai/                     OpenRouter client, model config, prompt builders
│   ├── audit/                  AuditEventType union + PII sanitizer
│   ├── calibration/            Brier score, reliability diagram
│   ├── forecast/               CSV parsing, sidecar client, ensemble adapter
│   ├── rag/                    BGE embeddings, LanceDB chunker/retrieval
│   ├── search/                 Tavily web-search provider
│   ├── types.ts                UncertaintyNode, NodeProvenance, graph types
│   └── validation/             Zod schemas for all persistence round-trips
├── services/ensemble/          Python FastAPI sidecar (ace_hospital wrapper)
│   ├── app.py                  EMA snapshot load/save + /train /predict /outcome /snapshot
│   └── tests/                  11 EMA durability tests (pytest)
├── prisma/
│   ├── schema.prisma           Analysis, Calibration, SemanticConversation, SemanticDocument
│   └── migrations/             3 applied migrations
├── __tests__/                  76 Jest suites (63 active, 13 gated)
├── scripts/                    check-env.mjs, preflight-models.mjs, smoke scripts
├── docker-compose.yml          ensemble sidecar + ensemble_data named volume
└── .github/workflows/ci.yml    CI: check-env → test → e2e → build
```

**Entry Points:**
- `app/page.tsx` — single-page shell, mounts Dashboard with all five mode tabs
- `app/api/semantic/route.ts` — POST creates conversation; GET lists
- `app/api/semantic/[id]/route.ts` — GET conversation; PATCH dispatches event + auto-advance
- `services/ensemble/app.py` — Python FastAPI sidecar (`uvicorn app:app --port 8001`)

**Key Modules:**

| Module | Path | Purpose | Status |
|--------|------|---------|--------|
| Semantic state machine | `lib/semantic/state-machine.ts` | Pure reducer, 12 states | ✅ |
| MODELING auto-advance | `lib/semantic/auto-advance.ts` | Server-side MC + sensitivity (P3a) | ✅ |
| bundleToNode | `lib/semantic/bundle-to-node.ts` | ResearchBundle → provenanced node (D1) | ✅ |
| Conversation export | `lib/semantic/export.ts` | JSON + Markdown export (D3) | ✅ |
| Monte Carlo engine | `lib/engine/monte-carlo.ts` | runSimulation() 10k samples | ✅ |
| Sensitivity analysis | `lib/engine/sensitivity.ts` | computeSensitivity() variance reduction | ✅ |
| EMA sidecar | `services/ensemble/app.py` | Calibration learning with persistence (P2) | ✅ |
| RAG pipeline | `lib/rag/` | BGE + LanceDB document retrieval (B3) | ✅ gated |
| Audit events | `lib/audit/events.ts` | PII-safe event emission (D2) | ✅ |

---

## How to Run

### Local Development
```bash
# One-time setup
cp .env.example .env
cp .env.example .env.local
# Edit .env.local — set OPENROUTER_API_KEY (required for LLM research mechanisms)
# Edit .env.local — set TAVILY_API_KEY (required for web_search mechanism only)

npm install
npx prisma generate
npx prisma db push

# Verify environment
npm run check:env       # → Environment preflight passed

# Start dev server
npm run dev             # → http://localhost:3000

# Optional: start Python ensemble sidecar (required for Forecast Mode)
docker compose up -d ensemble
curl -fsS http://localhost:8001/health   # → {"status":"ok",...}
```

### Tests
```bash
npm test -- --runInBand
```
**Current Status:** 962 passing, 0 failing, 25 skipped (13 suites skipped)  
**Known Skips:**
- 12 RAG integration tests gated behind `RUN_RAG_INTEGRATION=1`
- Integration tests requiring `OPENROUTER_API_KEY` and live OpenRouter (gated in CI env)

### Verification Suite
```bash
npm run check:env && npm test -- --runInBand && npm run build && npm run lint
```
**Pass Condition:** `987 tests, 0 failures` + `Compiled successfully` + `No ESLint warnings or errors`

---

## Current State Assessment

### What's Working ✅

**Semantic Mode — complete end-to-end (A1–A5, B1–B7, D1–D3, P3a–P3b):**
- A1 State machine: 12 states, all reducer transitions — 52 unit tests
- A2 Persistence + API: SQLite-backed conversation CRUD — 33 tests
- A3 Clarifying questions: LLM-generated, user-editable — 13 unit + 1 live integration
- A4 Component identification: LLM proposes uncertain factors — 14 unit + 1 live
- A5 Review UI + cockpit handoff + narration — 53 tests
- B1 LLM-prior research mechanism — 18 unit + 1 live
- B2 Web search via Tavily — 32 unit + 1 live
- B3 RAG over user-uploaded documents — ESM gap fixed; 12 unit tests (gated)
- B4 Multi-LLM consensus — 19 unit + 1 live
- B5 Forecast adapter (ensemble sidecar) — 13 unit + 1 sidecar live
- B5 Empirical observation adapter — 12 unit
- B6 Picker UI + RESEARCHING auto-advance — 38+ validator tests
- B7 Expert panel (structured elicitation) — 28 unit
- D1 NodeProvenance on UncertaintyNode — 30 bundle-to-node + 8 schema tests
- D2 Per-research-step audit events + citationCount — 5 tests
- D3 Dual JSON + Markdown conversation export — 25 export tests
- P3a MODELING auto-advance: `bundleToNode()` → `runSimulation(10k)` → `computeSensitivity()` → `modelComplete` applied server-side — 12 unit tests
- P3b Export download UI: JSON + MD buttons in ResultStep wired to `/api/semantic/[id]/export`

**Forecast Mode:** Time-series CSV → Python ensemble sidecar → per-model weights + 95% interval + calibration feedback loop (R6-06) ✅

**Calibration system:** Brier score, reliability diagram, EMA-based Beta prior updates ✅

**EMA snapshot durability (P2):** Atomic JSON snapshot written after every `/outcome`, restored on sidecar startup, Docker named volume `ensemble_data` — 11 pytest tests ✅

**Real Data Mode, Multi-LLM Proposer, Path A Simulation** ✅ (gated by `LEGACY_PATH_A_ENABLED`)

### What's Incomplete ⚠️

- **Path A non-dismissible banner** — still gated by `LEGACY_PATH_A_ENABLED=true`. No multi-LLM-graph-alignment (R6-07) planned.
- **RAG integration tests** — 12 tests require `RUN_RAG_INTEGRATION=1` + live `OPENROUTER_API_KEY`; smoke-tested via `npm run smoke:rag`.

### What's Broken ❌

None. All gates green.

### Current Blockers 🚧

None. All P0–P3 planned work is complete.

---

## Feature Completion Matrix

| Feature | Status | Evidence | Priority |
|---|---|---|---|
| Semantic state machine (A1) | ✅ | 52 unit tests | — |
| Conversation persistence + API (A2) | ✅ | 33 tests | — |
| Clarifying step (A3) | ✅ | 13 unit + 1 live | — |
| Component identification (A4) | ✅ | 14 unit + 1 live | — |
| Review UI + cockpit handoff + narration (A5) | ✅ | 53 tests | — |
| B1 LLM-prior research | ✅ | 18 unit + 1 live | — |
| B2 web search (Tavily) | ✅ | 32 unit + 1 live | — |
| B3 RAG over uploaded documents | ✅ | ESM gap fixed; 12 unit tests gated | — |
| B4 multi-LLM consensus | ✅ | 19 unit + 1 live | — |
| B5 Forecast adapter | ✅ | 13 unit + 1 sidecar live | — |
| B5 Empirical adapter | ✅ | 12 unit | — |
| B6 Picker UI + RESEARCHING auto-advance | ✅ | 38+ validator tests | — |
| B7 Expert panel | ✅ | 28 unit | — |
| D1 NodeProvenance migration | ✅ | 30 bundle-to-node + 8 schema tests | — |
| D2 per-research-step audit events | ✅ | 5 citationCount tests | — |
| D3 dual Markdown + JSON export | ✅ | 25 export tests | — |
| openrouter-client ≥90% coverage | ✅ | 98% lines | — |
| Reliability empty-bin canvas | ✅ | CalibrationModal hollow ticks for empty bins | — |
| Sidecar EMA durability (P2) | ✅ | atomic JSON snapshot + Docker named volume; 11 pytest | — |
| MODELING auto-advance (P3a) | ✅ | `lib/semantic/auto-advance.ts`; 12 unit tests | — |
| Export download UI (P3b) | ✅ | `components/semantic/ResultStep.tsx` JSON+MD buttons | — |
| Naked-straddle stash decision (P3c) | ✅ | stash@{0} dropped | — |

---

## Recent Changes

| SHA | Change | Why |
|---|---|---|
| `518f509` | docs: update handoff for P3 completion | Continuity |
| `fe4c03a` | feat(P3): MODELING auto-advance + ResultStep export download buttons | Close all P3 items; Semantic Mode modeling loop end-to-end server-side |
| `746b297` | docs: update handoff for EMA durability completion | Continuity |
| `14ae564` | feat(P2): EMA snapshot durability | Calibration learning survives container restarts |
| `7ee6933` | fix(P2): openrouter-client coverage uplift + reliability empty-bin canvas | Close last two P2 items |
| `c58f9f0` | feat(D3): dual Markdown + JSON conversation export | Reproducibility + audit trails |
| `10ba145` | feat(D2): per-research-step audit events + citationCount | Per-step traceability |
| `f8ed8df` | feat(D1): NodeProvenance from research bundles | Rich provenance for engine + export |
| `a23325d` | fix(rag): replace eval('require') with dynamic import + smoke:rag | Fix Jest ESM gap for RAG |

**Uncommitted Changes:** none  
**Stashed Work:** none (stash@{0} dropped this session)

---

## Configuration & Secrets

### Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `OPENROUTER_API_KEY` | All LLM research mechanisms | Yes (LLM features) |
| `TAVILY_API_KEY` | `web_search` research mechanism only | No (optional mechanism) |
| `DATABASE_URL` | Prisma SQLite — must be in `.env` AND `.env.local` | Yes |
| `OPENROUTER_MODELS` | Comma-sep model list shown in UI selector | Optional (has default) |
| `OPENROUTER_DEFAULT_MODEL` | Active model for all LLM calls | Optional (has default) |
| `OPENROUTER_TIMEOUT_MS` | Per-call timeout cap (default 60000) | Optional |
| `OPENROUTER_PER_CALL_BUDGET_USD` | Per-call cost ceiling (default $0.05) | Optional |
| `ENSEMBLE_SIDECAR_URL` | Python sidecar base URL (default `http://localhost:8001`) | Optional |
| `LEGACY_PATH_A_ENABLED` | Gate for Path A draft mode (default `true`) | Optional |
| `FINESS_LANCEDB_ROOT` | Override LanceDB root directory | Optional |
| `FINESS_RAG_MAX_UPLOAD_BYTES` | RAG upload size cap (default 10MB) | Optional |

### External Services

| Service | Purpose | Local Alternative |
|---|---|---|
| OpenRouter | LLM calls for all research mechanisms | None — required for Semantic Mode |
| Tavily | Web search snippets for `web_search` mechanism | None — required for that mechanism only |
| Python sidecar (Docker) | Forecast Mode + calibration EMA | `docker compose up -d ensemble` |

---

## Known Issues & Tech Debt

- **RAG integration tests gated**: 12 tests under `RUN_RAG_INTEGRATION=1`. Run `npm run smoke:rag` when `OPENROUTER_API_KEY` is set to verify the full B3 path live.
- **Path A non-dismissible banner**: `LEGACY_PATH_A_ENABLED` gates this mode; no further hardening planned.
- **CI sidecar gap**: `.github/workflows/ci.yml` does not spin up the Docker ensemble sidecar, so Forecast Mode integration tests run against a mock sidecar client in CI. This is intentional — the sidecar tests run in the Python pytest suite separately.

---

## Next Steps (Priority Order)

All P0–P3 planned work is complete. No outstanding tasks. Possible future directions (unscoped, not committed):

- **Sidecar CI integration** — add `docker compose up` step to CI so Forecast Mode lives in the GH Actions pipeline.
- **MODELING graph shapes beyond additive** — the current flat additive graph is a reasonable default; multiplicative or conditional nodes would require extending `bundleToNode()` and the graph builder in `runModeling()`.
- **Hosted mode auth** — the local single-user session (`/api/auth/local`) is not suitable for multi-user hosted deployments; NextAuth or similar would be needed.

---

## Key Files Reference

| File | Purpose | When to Modify |
|---|---|---|
| `lib/types.ts` | Core types incl. `UncertaintyNode`, `NodeSource`, `NodeProvenance` | Adding a new source kind or provenance field |
| `lib/semantic/state-machine.ts` | Pure reducer — all 12 states + events | Adding a new state or event |
| `lib/semantic/auto-advance.ts` | Server-side LLM dispatch + MODELING Monte Carlo | Adding a new mechanism, graph shape, or audit field |
| `lib/semantic/bundle-to-node.ts` | `ResearchBundle` → `UncertaintyNode` converter | Adding a new distribution or param mapping |
| `lib/semantic/export.ts` | Conversation → JSON / Markdown | Changing the export schema or adding fields |
| `lib/engine/monte-carlo.ts` | `runSimulation()` — 10k sample Monte Carlo | Changing simulation config or output shape |
| `lib/engine/sensitivity.ts` | `computeSensitivity()` — variance reduction | Changing sensitivity algorithm |
| `lib/audit/events.ts` | `AuditEventType` union + `FORBIDDEN_AUDIT_METADATA_KEYS` | Adding a new audit event or PII rule |
| `app/api/semantic/[id]/route.ts` | PATCH handler — dispatches event + runs auto-advance | Changing auto-advance loop or response shape |
| `app/api/semantic/[id]/export/route.ts` | Export endpoint | Adding new format or auth change |
| `components/semantic/ResultStep.tsx` | Result display + export download buttons | Changing result UI or export trigger |
| `components/SemanticPanel.tsx` | Top-level Semantic Mode container | Adding a new step or wiring a new prop |
| `services/ensemble/app.py` | Python sidecar — EMA persistence + forecast endpoints | Adding new endpoints or changing snapshot schema |
| `docker-compose.yml` | Sidecar service + `ensemble_data` named volume | Adding services or changing volume config |
| `prisma/schema.prisma` | DB schema — Analysis, Calibration, SemanticConversation, Document | Adding a new table or column |

---

## Open Questions / Decisions Needed

None outstanding. All open questions from prior sessions have been resolved.

---

## Appendix: Machine-Readable Summary

```json
{
  "project": "finess",
  "generated": "2026-05-21T18:30:00Z",
  "repo": {
    "branch": "main",
    "commit": "518f509",
    "commit_date": "2026-05-21T15:55:47Z",
    "uncommitted_changes": false,
    "stashed_work": 0,
    "remote_in_sync": true
  },
  "stack": {
    "language": "TypeScript",
    "language_version": "Node 20 (CI)",
    "framework": "Next.js",
    "framework_version": "14.2.35"
  },
  "health": {
    "tests_passing": 962,
    "tests_failing": 0,
    "tests_skipped": 25,
    "lint_clean": true,
    "type_check_clean": true,
    "build_clean": true
  },
  "status": {
    "working": [
      "Semantic Mode full pipeline A1-A5 + B1-B7 + D1-D3 + P3a-P3b",
      "MODELING auto-advance (bundleToNode + MC 10k samples + sensitivity, server-side)",
      "Export download UI (JSON + MD buttons in ResultStep)",
      "Forecast Mode + R6-06 calibration loop",
      "Sidecar EMA snapshot durability (atomic JSON + Docker named volume)",
      "Real Data Mode",
      "Multi-LLM Proposer",
      "Path A draft mode (gated)",
      "NodeProvenance on UncertaintyNode",
      "Per-research-step audit events",
      "Dual JSON + Markdown conversation export",
      "Reliability empty-bin canvas",
      "openrouter-client coverage 98%"
    ],
    "incomplete": [
      "RAG integration tests gated (RUN_RAG_INTEGRATION=1)",
      "Path A banner non-dismissible (LEGACY_PATH_A_ENABLED gate)"
    ],
    "broken": [],
    "blockers": []
  },
  "continuity": {
    "previous_handoff_loaded": true,
    "assumptions_imported": 0,
    "debt_items_imported": 1,
    "error_refs_imported": 0
  },
  "feature_completion_matrix": [
    {"feature": "Semantic state machine (A1)", "status": "✅", "evidence": "__tests__/semantic/state-machine.test.ts", "priority": "—"},
    {"feature": "Conversation persistence + API (A2)", "status": "✅", "evidence": "__tests__/semantic/persistence.test.ts", "priority": "—"},
    {"feature": "Clarifying step (A3)", "status": "✅", "evidence": "__tests__/semantic/clarify.test.ts", "priority": "—"},
    {"feature": "Component identification (A4)", "status": "✅", "evidence": "__tests__/semantic/propose-components.test.ts", "priority": "—"},
    {"feature": "Review UI + cockpit + narration (A5)", "status": "✅", "evidence": "__tests__/semantic/narration.test.ts", "priority": "—"},
    {"feature": "B1 LLM-prior research", "status": "✅", "evidence": "__tests__/semantic/research/", "priority": "—"},
    {"feature": "B2 web search (Tavily)", "status": "✅", "evidence": "__tests__/search/tavily.test.ts", "priority": "—"},
    {"feature": "B3 RAG over documents", "status": "✅", "evidence": "__tests__/rag/ (unit); gated integration", "priority": "—"},
    {"feature": "B4 multi-LLM consensus", "status": "✅", "evidence": "__tests__/ai/multi-proposer.test.ts", "priority": "—"},
    {"feature": "B5 Forecast adapter", "status": "✅", "evidence": "__tests__/api/forecast.test.ts", "priority": "—"},
    {"feature": "B5 Empirical adapter", "status": "✅", "evidence": "__tests__/semantic/research/", "priority": "—"},
    {"feature": "B6 Picker UI + RESEARCHING auto-advance", "status": "✅", "evidence": "__tests__/validation/semantic.test.ts", "priority": "—"},
    {"feature": "B7 Expert panel", "status": "✅", "evidence": "__tests__/semantic/research/", "priority": "—"},
    {"feature": "D1 NodeProvenance", "status": "✅", "evidence": "__tests__/semantic/bundle-to-node.test.ts (30)", "priority": "—"},
    {"feature": "D2 audit refinements", "status": "✅", "evidence": "__tests__/semantic/auto-advance-citation-count.test.ts (5)", "priority": "—"},
    {"feature": "D3 conversation export", "status": "✅", "evidence": "__tests__/semantic/export.test.ts (25)", "priority": "—"},
    {"feature": "P2 openrouter-client coverage", "status": "✅", "evidence": "98% lines", "priority": "—"},
    {"feature": "P2 reliability empty-bin canvas", "status": "✅", "evidence": "components/CalibrationModal.tsx", "priority": "—"},
    {"feature": "P2 sidecar EMA durability", "status": "✅", "evidence": "services/ensemble/tests/test_ema_snapshot.py (11)", "priority": "—"},
    {"feature": "P3a MODELING auto-advance", "status": "✅", "evidence": "__tests__/semantic/auto-advance-modeling.test.ts (12)", "priority": "—"},
    {"feature": "P3b export download UI", "status": "✅", "evidence": "components/semantic/ResultStep.tsx", "priority": "—"},
    {"feature": "P3c naked-straddle stash decision", "status": "✅", "evidence": "stash@{0} dropped", "priority": "—"}
  ],
  "verification_suite": {
    "command": "npm run check:env && npm test -- --runInBand && npm run build && npm run lint",
    "pass_condition": "987 tests, 0 failures, build compiled, no lint warnings",
    "result": "pass"
  },
  "next_steps": []
}
```
