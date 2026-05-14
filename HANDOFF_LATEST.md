# finESS — Handoff Packet
**Generated:** 2026-05-13
**Branch:** `master` @ `36e4b8f`
**Last Commit:** 2026-05-13 — test: comprehensive coverage expansion — 80 tests, 100% statements/lines

---

## Quick Resume Checklist
- [ ] Clone/pull and checkout `master`
- [ ] `cp .env.example .env.local` (or provide real `OPENROUTER_API_KEY`)
- [ ] `npm install`
- [ ] `npx prisma generate && npx prisma db push`
- [ ] `npm test` — expect 80 tests passing, 0 failures
- [ ] `npm run build` — expect clean production build
- [ ] `npm run dev` — expect dashboard at http://localhost:3000
- [ ] Review "Current Blockers" and "Next Steps" sections below

## AI Continuity Checklist
- [x] Latest handoff reviewed (this is the first handoff)
- [x] Open assumptions imported — see "Open Questions" section
- [x] Open debt items imported — see "Known Issues & Tech Debt" section
- [ ] Verification suite executed
- [ ] Next actions prioritized (P0/P1/P2)

---

## What This Project Does

finESS ("Uncertainty Intelligence") is a platform where users describe decisions in plain language, AI builds probabilistic uncertainty models using 6 principles of honest uncertainty, and users watch live Monte Carlo simulations through an immersive 6-panel animated dashboard. Domain-agnostic: clinical, financial, engineering, legal.

**Tech Stack:** TypeScript, Next.js 14 (App Router), React 18, Tailwind CSS, Prisma 6 + SQLite, Canvas 2D, Web Workers
**Architecture Pattern:** Full-stack monolith — browser-side Monte Carlo engine in Web Workers, server-side AI pipeline + persistence via API routes

---

## Project Structure
```
finESS/
├── app/                          # Next.js 14 App Router
│   ├── page.tsx                  # Main orchestration page (client component)
│   ├── layout.tsx                # Root layout
│   ├── globals.css               # Dark theme + animations
│   └── api/
│       ├── analyze/route.ts      # POST: AI graph generation (OpenRouter)
│       ├── analyses/route.ts     # GET: list, POST: save analyses
│       ├── analyses/[id]/route.ts # GET/DELETE: single analysis
│       └── calibration/route.ts  # GET: calibration curve, POST: real outcomes
├── components/                   # React components
│   ├── Dashboard.tsx             # 6-panel CSS grid layout
│   ├── InputBar.tsx              # NL input + example scenarios dropdown
│   ├── ModelSelector.tsx         # User-selected AI model (no default)
│   ├── NarrationStream.tsx       # Live text narration panel
│   ├── NodeEditor.tsx            # What-If editing (sliders + expert panel)
│   └── panels/                   # Canvas 2D visualization panels
│       ├── NodeNetwork.tsx       # Animated node graph with click-to-edit
│       ├── LiveDistribution.tsx  # Progressive histogram
│       ├── SensitivityRadar.tsx  # Radar + tornado chart toggle
│       ├── GaugePanel.tsx        # 4 analog gauge dials
│       └── SpectrumBars.tsx      # Per-node mini-histograms
├── lib/                          # Business logic
│   ├── types.ts                  # All core type definitions
│   ├── db.ts                     # Prisma client singleton
│   ├── ai/
│   │   ├── prompt.ts             # System prompt with PE worked example
│   │   └── parse-response.ts     # Strict AI response validator
│   ├── engine/
│   │   ├── prng.ts               # Mulberry32 seeded PRNG
│   │   ├── distributions.ts      # Beta, normal, uniform, lognormal sampling
│   │   ├── dag-executor.ts       # DAG edge-group topological walker
│   │   ├── monte-carlo.ts        # runSimulation + runSimulationBatched
│   │   ├── sensitivity.ts        # Dual: fix-to-mean + halve-SD methods
│   │   ├── worker.ts             # Web Worker for background MC
│   │   └── use-simulation.ts     # React hook (phase/progress/result)
│   ├── examples/
│   │   ├── pe-scenario.ts        # Pre-built PE graph (instant demo, seed=42)
│   │   └── example-queries.ts    # 4 domain example queries
│   └── viz/
│       └── node-layout.ts        # Force-directed layout for node network
├── __tests__/                    # Jest test suite (80 tests)
│   ├── ai/
│   │   └── parse-response.test.ts
│   └── engine/
│       ├── test-fixtures.ts      # PE graph + Python golden reference
│       ├── prng.test.ts
│       ├── distributions.test.ts
│       ├── dag-executor.test.ts
│       ├── monte-carlo.test.ts
│       └── sensitivity.test.ts
├── prisma/
│   ├── schema.prisma             # Analysis + CalibrationOutcome models
│   └── dev.db                    # SQLite development database
├── docs/plans/                   # Design & implementation docs
│   ├── 2026-05-12-finESS-platform-design.md
│   ├── 2026-05-12-finESS-implementation-plan.md
│   └── 2026-05-13-finESS-implementation-plan-v2.md
├── distribclin_app.py            # Python v0.1 reference (original prototype)
├── distribclin_expert_system2.py # Python v0.2 reference (expert system)
└── *.html                        # Pre-existing reference HTML demos (untracked)
```

**Entry Points:**
- `app/page.tsx` — Main UI orchestration (wires all panels, AI submission, simulation hook)
- `lib/engine/worker.ts` — Web Worker entry point for Monte Carlo execution
- `app/api/analyze/route.ts` — AI pipeline entry point

**Key Modules:**
| Module | Path | Purpose | Status |
|--------|------|---------|--------|
| Type System | `lib/types.ts` | All core interfaces (UncertaintyNode, ReasoningEdge, Graph, etc.) | ✅ |
| PRNG | `lib/engine/prng.ts` | Mulberry32 seeded PRNG + Box-Muller normal | ✅ |
| Distributions | `lib/engine/distributions.ts` | Beta (gamma method), normal, uniform, lognormal | ✅ |
| DAG Executor | `lib/engine/dag-executor.ts` | Topological edge-group walker (additive/sub/bayes/mult) | ✅ |
| Monte Carlo | `lib/engine/monte-carlo.ts` | Full run + batched streaming | ✅ |
| Sensitivity | `lib/engine/sensitivity.ts` | Dual: fix-to-mean (variance) + halve-SD (CI width) | ✅ |
| AI Prompt | `lib/ai/prompt.ts` | System prompt with PE few-shot example | ✅ |
| AI Parser | `lib/ai/parse-response.ts` | Strict JSON validation of AI output | ✅ |
| Web Worker | `lib/engine/worker.ts` | Background MC with batch streaming | ✅ |
| React Hook | `lib/engine/use-simulation.ts` | Phase/progress/result state management | ✅ |
| Dashboard | `components/Dashboard.tsx` | 12-col, 6-row CSS grid layout | ✅ |
| Node Network | `components/panels/NodeNetwork.tsx` | Canvas 2D animated graph + click-to-edit | ✅ |
| Live Distribution | `components/panels/LiveDistribution.tsx` | Progressive histogram | ✅ |
| Sensitivity Radar | `components/panels/SensitivityRadar.tsx` | Radar/tornado toggle | ✅ |
| Gauges | `components/panels/GaugePanel.tsx` | 4 analog dials | ✅ |
| Spectrum Bars | `components/panels/SpectrumBars.tsx` | Per-node mini-histograms | ✅ |
| Node Editor | `components/NodeEditor.tsx` | Slider mode + Expert Panel | ✅ |
| Persistence | `prisma/schema.prisma` + API routes | Save/load analyses, calibration | ✅ |

---

## How to Run

### Local Development
```bash
# Setup (one-time)
npm install
cp .env.example .env.local  # or manually create with OPENROUTER_API_KEY=your_key
npx prisma generate
npx prisma db push

# Run
npm run dev

# Expected: Dashboard at http://localhost:3000
# Click "Examples" → "Pulmonary Embolism Risk (Instant)" for immediate demo
# The PE demo runs entirely client-side, no API key needed
```

### Tests
```bash
npm test           # Run all tests
npm run test:coverage  # With coverage report
```
**Current Status:** 80 passing, 0 failing, 0 skipped
**Known Failures:** none

### Build
```bash
npm run build
```
**Current Status:** Clean production build. All routes registered. No type errors, no ESLint errors.

### Verification Suite
```bash
npm test && npm run build
```
**Pass Condition:** 80 tests pass, build exits 0 with "Compiled successfully"

---

## Current State Assessment

### What's Working ✅
- **Monte Carlo Engine** — Deterministic, seeded, DAG-walking MC with 4 distribution types and 4 combination methods. Validated against Python golden reference. 100% test coverage on statements/lines.
- **AI Pipeline** — OpenRouter integration with strict response parsing. User selects model (no hardcoded default). 100% test coverage.
- **6-Panel Dashboard** — All Canvas 2D panels render: node network, live distribution, sensitivity radar/tornado, gauges, spectrum bars, narration stream.
- **What-If Editing** — Click any node to open editor. Slider mode (mean/SD) and Expert Panel mode (disagreement → variance). Apply & re-run triggers new simulation.
- **PE Demo** — Instant demo (no API call) with pre-built 6-node PE graph, seed=42, reproducible results.
- **Persistence** — Prisma/SQLite save/load analyses. Calibration API accepts real outcomes only (no mock), requires 20+ before showing curve.
- **Example Scenarios** — 4 domains: clinical PE, startup investment, bridge safety, patent litigation.
- **Production Build** — Clean build with all API routes registered.
- **Test Suite** — 80 tests, 100% statements, 96.55% branches, 100% functions, 100% lines.

### What's Incomplete ⚠️
- **End-to-End AI Testing** — AI pipeline is built but not end-to-end tested against a live OpenRouter call (requires API key and costs real money). Parser is thoroughly tested against all edge cases.
- **Calibration UI Panel** — API routes exist and work, but no frontend panel to record outcomes or view the calibration curve. Data layer is complete.
- **Save/Load UI** — API routes exist (CRUD), but no frontend buttons/modals to save/load analyses. The backend is fully functional.
- **Component Tests** — React components (Canvas panels, editors) have no unit tests. Only engine/AI logic is tested. UI was verified via manual build + dev server.
- **CI/CD** — No GitHub Actions or deployment pipeline configured.
- **`.env.example`** — No example env file exists. Users must know to set `OPENROUTER_API_KEY` and `DATABASE_URL`.
- **Web Worker in Dev Mode** — Worker instantiation via `new URL('./worker.ts', import.meta.url)` works in production build but may have issues in some dev server HMR configurations.

### What's Broken ❌
- Nothing is known to be broken. All tests pass, build succeeds.

### Current Blockers 🚧
- **OpenRouter API Key** — Must be configured in `.env.local` for AI-generated graphs. The PE demo works without it.

### Feature Completion Matrix
| Feature | Status | Evidence | Gap to Done | Priority |
|---------|--------|----------|-------------|----------|
| Monte Carlo Engine | ✅ | 80 tests pass, golden ref validated | — | — |
| DAG Executor (4 methods) | ✅ | `dag-executor.test.ts` 13 tests | — | — |
| Sensitivity Analysis (dual) | ✅ | `sensitivity.test.ts` 10 tests | — | — |
| AI Graph Generation | ✅ | `parse-response.test.ts` 26 tests | — | — |
| 6-Panel Dashboard | ✅ | `npm run build` clean, dev server verified | Component tests | P2 |
| Node Network (Canvas) | ✅ | Visual verification in dev | — | — |
| Live Distribution | ✅ | Visual verification in dev | — | — |
| Sensitivity Radar/Tornado | ✅ | Visual verification in dev | — | — |
| Gauges | ✅ | Visual verification in dev | — | — |
| Spectrum Bars | ✅ | Visual verification in dev | — | — |
| What-If Node Editing | ✅ | `NodeEditor.tsx` complete | — | — |
| Expert Panel Mode | ✅ | Disagreement → variance (Principle 2) | — | — |
| Save/Load API | ✅ | API routes functional | Frontend UI | P1 |
| Calibration API | ✅ | API routes functional | Frontend UI | P1 |
| PE Instant Demo | ✅ | Pre-built graph, seed=42 | — | — |
| Example Scenarios | ✅ | 4 domains in dropdown | — | — |
| Model Selector | ✅ | User selects, no default | — | — |
| CSS Animations | ✅ | fadeIn, pulse-glow, shimmer, scanline, panel-hover | — | — |
| `.env.example` | ❌ | Missing | Create template file | P1 |
| CI/CD Pipeline | ❌ | No config | GitHub Actions setup | P2 |
| Calibration UI | ⚠️ | Backend complete | Frontend panel | P1 |
| Save/Load UI | ⚠️ | Backend complete | Frontend buttons/modal | P1 |
| Component Tests | ⚠️ | No React component tests | Canvas/UI testing | P2 |

---

## Recent Changes

| Date | SHA | Change | Why |
|------|-----|--------|-----|
| 2026-05-13 | `36e4b8f` | Comprehensive test expansion (50→80 tests) | Push coverage to 100% statements/lines, cover all validation branches |
| 2026-05-13 | `3874bcb` | Interactive features, persistence, polish, examples | NodeEditor, Prisma, API routes, animations, example scenarios |
| 2026-05-13 | `0895759` | 6-panel dashboard with Canvas 2D | All 5 visualization panels + Dashboard grid + InputBar + ModelSelector + Narration |
| 2026-05-13 | `03837c4` | AI pipeline with OpenRouter + parser | System prompt, response parser, /api/analyze endpoint |
| 2026-05-13 | `1b0d8cf` | Web Worker wrapper + useSimulation hook | Browser-side MC execution with batch streaming |
| 2026-05-13 | `02e8a51` | Monte Carlo engine + DAG executor | PRNG, distributions, topological DAG walker, dual sensitivity |
| 2026-05-13 | `049cd85` | Core type definitions | All interfaces: UncertaintyNode, ReasoningEdge, Graph, Config, Result |
| 2026-05-13 | `1255cd8` | Initialize Next.js project | Next.js 14, TypeScript strict, Tailwind, dark theme |

**Uncommitted Changes:** 4 untracked HTML files (pre-existing reference demos: `distribclin_demo.html`, `distribclin_expert_system_demo2.html`, `hometier-app.html`, `hometier-app2.html`). These are reference prototypes from the design phase, not part of the application.

**Stashed Work:** none

---

## Configuration & Secrets

### Environment Variables
| Variable | Purpose | Where to Get |
|----------|---------|--------------|
| `OPENROUTER_API_KEY` | AI model access via OpenRouter | https://openrouter.ai/keys |
| `DATABASE_URL` | Prisma database connection | Default: `file:./dev.db` (SQLite) |

### External Dependencies
| Service | Purpose | Local Alternative |
|---------|---------|-------------------|
| OpenRouter API | AI graph generation from NL input | PE demo works offline; other scenarios require API key |
| SQLite | Persistence (analyses, calibration) | Built-in, no external service needed |

---

## Known Issues & Tech Debt

- [ ] **No `.env.example`** — New developers must manually discover required env vars. Should create a template. `app/api/analyze/route.ts:24`
- [ ] **Untracked reference files** — 4 HTML files + 2 Python files in project root are pre-existing prototypes. Should be moved to `docs/reference/` or `.gitignore`'d.
- [ ] **Model selector suggestions may go stale** — `SUGGESTED_MODELS` in `ModelSelector.tsx:10-15` lists specific model IDs that may be deprecated on OpenRouter. User can always enter custom model ID.
- [ ] **Web Worker HMR** — `new URL('./worker.ts', import.meta.url)` pattern works in production but may have edge cases in Next.js dev HMR. `lib/engine/use-simulation.ts:74-76`
- [ ] **Remaining branch coverage gap (3.45%)** — Uncovered branches are defensive null coalescing (`?? 0`, `?? 1`) in `dag-executor.ts:117,158-168` and zero-variance guards in `sensitivity.ts:42-52`. These protect against impossible states in normal usage.
- [ ] **No API route tests** — The 4 API routes (`analyze`, `analyses`, `analyses/[id]`, `calibration`) have no integration tests. They've been verified via build + dev server but not automated.
- [ ] **Calibration threshold of 20** — The `MIN_OUTCOMES_FOR_CURVE = 20` in `calibration/route.ts:4` is a somewhat arbitrary choice. May need tuning based on statistical power requirements.

---

## Next Steps (Priority Order)

1. **P1: Build Save/Load UI** — Add "Save" button to page header (after simulation completes) and "Load" modal listing saved analyses. Backend is done (`/api/analyses`). "Done" = user can save, reload, and delete analyses from the UI.

2. **P1: Build Calibration UI** — Add a calibration panel (or modal) where users can: (a) record actual outcomes for saved analyses, (b) view calibration curve once 20+ outcomes exist. Backend is done (`/api/calibration`). "Done" = full CRUD on outcomes + visual calibration curve.

3. **P1: Create `.env.example`** — Template file with all required and optional environment variables, with documentation comments. "Done" = new developer can `cp .env.example .env.local` and know exactly what to fill in.

4. **P2: Add CI/CD Pipeline** — GitHub Actions workflow: install → lint → test → build. "Done" = PRs run automated checks, main branch deploys on merge.

5. **P2: Component/E2E Tests** — Add React Testing Library tests for key components (InputBar, ModelSelector, NodeEditor). Consider Playwright for E2E flows (PE demo, example selection). "Done" = >80% component coverage.

6. **P2: Clean up reference files** — Move `distribclin_*.py`, `distribclin_*.html`, `hometier-*.html` to `docs/reference/` or add to `.gitignore`. "Done" = clean project root.

7. **P2: Add `custom` edge method** — The type system defines `"custom"` as a CombinationMethod but the DAG executor doesn't handle it. Either implement with user-defined JS function or remove from the type. `lib/types.ts:14`, `lib/engine/dag-executor.ts`.

---

## Key Files Reference

| File | Purpose | When to Modify |
|------|---------|----------------|
| `lib/types.ts` | All core type definitions | Adding new node properties, edge methods, or result fields |
| `lib/engine/dag-executor.ts` | DAG edge-group walker | Adding new combination methods or changing computation order |
| `lib/engine/monte-carlo.ts` | Simulation runner | Changing sample generation, batch size, or statistics |
| `lib/engine/sensitivity.ts` | Dual sensitivity analysis | Adding new sensitivity methods or changing ranking |
| `lib/ai/prompt.ts` | AI system prompt | Changing how AI generates graphs, adding examples |
| `lib/ai/parse-response.ts` | Response validator | Adding new fields, distributions, or edge methods |
| `app/page.tsx` | Main page orchestration | Adding new UI sections, changing flow |
| `components/Dashboard.tsx` | Panel grid layout | Changing panel arrangement or adding panels |
| `components/NodeEditor.tsx` | What-If editing | Adding new editing modes or node properties |
| `prisma/schema.prisma` | Database schema | Adding new models or fields (run `npx prisma db push`) |
| `__tests__/engine/test-fixtures.ts` | Test reference data | When PE graph structure changes |
| `docs/plans/2026-05-13-finESS-implementation-plan-v2.md` | Active build plan | Reference for design decisions and architecture rationale |

---

## Open Questions / Decisions Needed

- **Multi-model comparison** — Should users be able to run the same query through multiple AI models and compare the generated graphs? The architecture supports it (model is passed per-request) but no UI exists.
- **Calibration display location** — Should calibration be a 7th panel, a modal, or a separate page? Currently no frontend for it.
- **Custom edge method** — The type system allows `"custom"` as a CombinationMethod but the executor ignores it. Should it be implemented (user-defined function) or removed?
- **Graph sharing** — Should users be able to share analyses via URL? Would require making the analysis load endpoint public.
- **Mobile responsiveness** — The 12-col grid is designed for desktop. No responsive breakpoints exist for mobile/tablet.

---

## Architecture Notes

### The 6 Principles of Honest Uncertainty (Foundation)
1. **Distributions not verdicts** — Every factor is a full distribution, never a point estimate
2. **Expert disagreement = variance** — When experts disagree, the disagreement IS the uncertainty (SD)
3. **AI estimates inputs, classical math propagates** — AI picks the nodes, Monte Carlo propagates
4. **Calibration is the metric** — Real outcomes validate predictions over time (requires 20+ outcomes)
5. **Sensitivity analysis tells what to verify** — Dual method shows both variance contribution and information value
6. **Wide interval = useful honesty** — A wide CI is more honest than a narrow false one

### DAG Computation Flow (v0.2 PE Example)
```
pre_test_base ──────additive──→ pre_test_composed ──additive──→ output
patient_modifier ───additive──→ pre_test_composed                 ↑
comorbidity_adjust ─additive──→ pre_test_composed        bayesian_update
                                                                  ↑
lab_variability ──subtractive──→ d_dimer_spec ───bayesian_update──┘
d_dimer_sens ──────────────────────────────────→ bayesian_update──┘
```

### Key Design Decisions
- **Per-edge methods** instead of monolithic `computeFn` — enables mixed-method graphs
- **Browser-side Monte Carlo** via Web Workers — no server load, instant PE demo
- **Seeded PRNG (Mulberry32)** — deterministic reproduction, seed saved with every result
- **Canvas 2D** instead of D3.js — direct pixel control, no DOM overhead for animations
- **Prisma v6** (not v7) — v7 requires adapter options that broke standard `new PrismaClient()`
- **OpenRouter** (not direct vendor APIs) — single API key for all models, user selects model
- **No hardcoded model** — user ALWAYS selects the AI model (per project policy)

---

## Appendix: Machine-Readable Summary
```json
{
  "project": "finESS",
  "generated": "2026-05-13",
  "repo": {
    "branch": "master",
    "commit": "36e4b8f78329b2660a2a867d2d19e736f1a16e22",
    "commit_date": "2026-05-13T12:08:57-04:00",
    "uncommitted_changes": false,
    "stashed_work": 0
  },
  "stack": {
    "language": "TypeScript",
    "language_version": "^5",
    "framework": "Next.js",
    "framework_version": "14.2.35"
  },
  "health": {
    "tests_passing": 80,
    "tests_failing": 0,
    "tests_skipped": 0,
    "lint_clean": true,
    "type_check_clean": true
  },
  "status": {
    "working": [
      "Monte Carlo engine (DAG executor, 4 distributions, dual sensitivity)",
      "AI pipeline (OpenRouter + strict parser)",
      "6-panel Canvas 2D dashboard",
      "What-If node editing (slider + expert panel)",
      "PE instant demo (seed=42)",
      "Persistence API (save/load/delete analyses)",
      "Calibration API (real outcomes only)",
      "Example scenarios (4 domains)",
      "Model selector (user-selected, no default)",
      "CSS animations and dark theme"
    ],
    "incomplete": [
      "Save/Load frontend UI (backend done)",
      "Calibration frontend UI (backend done)",
      ".env.example template",
      "Component/E2E tests",
      "CI/CD pipeline"
    ],
    "broken": [],
    "blockers": [
      "OPENROUTER_API_KEY required for AI-generated graphs (PE demo works without it)"
    ]
  },
  "continuity": {
    "previous_handoff_loaded": false,
    "assumptions_imported": 0,
    "debt_items_imported": 0,
    "error_refs_imported": 0
  },
  "feature_completion_matrix": [
    {"feature": "Monte Carlo Engine", "status": "✅", "evidence": "__tests__/engine/*.test.ts (55 tests)", "priority": "—"},
    {"feature": "AI Pipeline", "status": "✅", "evidence": "__tests__/ai/parse-response.test.ts (25 tests)", "priority": "—"},
    {"feature": "6-Panel Dashboard", "status": "✅", "evidence": "npm run build clean", "priority": "—"},
    {"feature": "What-If Editing", "status": "✅", "evidence": "components/NodeEditor.tsx", "priority": "—"},
    {"feature": "PE Demo", "status": "✅", "evidence": "lib/examples/pe-scenario.ts", "priority": "—"},
    {"feature": "Persistence API", "status": "✅", "evidence": "app/api/analyses/route.ts", "priority": "—"},
    {"feature": "Calibration API", "status": "✅", "evidence": "app/api/calibration/route.ts", "priority": "—"},
    {"feature": "Save/Load UI", "status": "⚠️", "evidence": "API routes only", "priority": "P1"},
    {"feature": "Calibration UI", "status": "⚠️", "evidence": "API routes only", "priority": "P1"},
    {"feature": ".env.example", "status": "❌", "evidence": "missing", "priority": "P1"},
    {"feature": "CI/CD", "status": "❌", "evidence": "no .github/workflows", "priority": "P2"},
    {"feature": "Component Tests", "status": "⚠️", "evidence": "no React component tests", "priority": "P2"}
  ],
  "verification_suite": {
    "command": "npm test && npm run build",
    "pass_condition": "80 tests pass, build exits 0",
    "result": "pass"
  },
  "next_steps": [
    {"task": "Build Save/Load frontend UI", "priority": "P1", "scope": "medium"},
    {"task": "Build Calibration frontend UI", "priority": "P1", "scope": "medium"},
    {"task": "Create .env.example template", "priority": "P1", "scope": "small"},
    {"task": "Add CI/CD pipeline (GitHub Actions)", "priority": "P2", "scope": "small"},
    {"task": "Add component/E2E tests", "priority": "P2", "scope": "medium"},
    {"task": "Clean up reference files in project root", "priority": "P2", "scope": "small"},
    {"task": "Implement or remove 'custom' edge method", "priority": "P2", "scope": "small"}
  ]
}
```
