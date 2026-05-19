# Semantic Mode Realignment — Original Design Recovery

**Generated:** 2026-05-19
**Trigger:** User identified that the vaporware-to-real mitigation work (committed on `main` through `ae14e85`) missed the core original design intent. We built around forecasting and multi-LLM proposers when the original intent was a **semantic AI pipeline that decomposes a question into components, researches each component's distribution, and propagates uncertainty** — with multiple model families beyond just Monte Carlo.

This document captures what we found in the original artifacts on disk so the realignment plan can be specific.

## Original artifacts inspected

| File | Status | What it actually is |
|---|---|---|
| `distribclin_app.py` (553 lines) | Python | v0.1 static report generator. Defines pre-test / sensitivity / specificity inline, runs Bayes + MC, exports `distribclin_demo.html`. **Source of the 6 Principles** (lines 386-421 of generated HTML). |
| `distribclin_expert_system2.py` (408 lines) | Python | v0.2. Adds explicit multi-node NODES dict (6 PE-domain nodes), per-node sensitivity ("fix to mean" variance attribution). Still a static report generator. Source of the PE worked example in `lib/ai/prompt.ts`. |
| `distribclin_demo.html` (235 KB) | HTML | Rendered output of v0.1. |
| `distribclin_expert_system_demo2.html` (278 KB) | HTML | Rendered output of v0.2. |
| `hometier-app.html` / `hometier-app2.html` (115 / 142 KB) | HTML+JS | A separate app: 30-year retirement-planning Monte Carlo with **10 explicit risk nodes**, embedded Triangular sampling, runtime AI node-generation, and per-node editing. This is the closest to a semantic-pipeline UI in the originals. |

## The 6 Principles (from `distribclin_app.py` and rendered HTML)

1. **Distributions, not verdicts** — no binary classification; show the full posterior.
2. **Expert disagreement = variance, not error** — multiple expert estimates feed input SD.
3. **AI estimates inputs. Classical math propagates.** — LLM/literature gives point + confidence; MC + Bayes does the rest.
4. **Calibration is the metric** — reliability diagrams, not AUC.
5. **Sensitivity tells you what to verify next** — rank inputs by leverage on output uncertainty.
6. **A wide interval is useful honesty** — wide CIs are actionable, not a failure mode.

## What's in finESS today vs what the originals had

### Distribution types
| Original | In finESS today |
|---|---|
| Beta | ✓ |
| Normal | ✓ |
| Uniform | ✓ |
| Lognormal | ✓ |
| **Triangular** (mode + min + max) | ✗ **Missing** — used heavily in hometier (inflation, healthcare shocks, SSI changes, market drag) |
| **Bernoulli mixture** (probabilistic event gating: `if Math.random() < p`) | ✗ **Missing** — used in hometier for episodic events (e.g. major home repair surprise) |

### Engine capabilities
| Original | In finESS today |
|---|---|
| Single-shot DAG MC | ✓ (`lib/engine/monte-carlo.ts`) |
| Bayes update edges | ✓ (`dag-executor.ts`) |
| "Fix to mean" sensitivity | ✓ (`lib/engine/sensitivity.ts`) |
| "Halve SD" / "what to verify next" sensitivity | ✓ (`sensitivity.ts`) |
| One-way tornado | ✓ (`sensitivity.ts`) |
| **Path-dependent / multi-step simulation** (30-year drawdown loop in hometier) | ✗ **Missing** — engine is single-step DAG; hometier-style longitudinal sim is not supported |
| **Calibration / reliability diagram** | Partial — Calibration data is recorded (R6-06) but no reliability diagram in the UI |
| **Brier score / scoring rules** | ✗ **Missing** — explicitly called out as principle 4 metric |
| **Node "impact" tags** (low / medium / high / critical) | ✗ **Missing** — hometier had these as first-class node metadata |

### Semantic pipeline (the user's actual ask)
| Original intent | In finESS today |
|---|---|
| **User asks question in natural language** | ✓ (Path A input bar) |
| **LLM asks clarifying questions inline** | ✗ **Missing entirely** |
| **LLM identifies key components, user reviews/edits the component list** | ✗ **Missing** — single LLM call jumps straight to a full graph |
| **Per-component research for distribution type** (literature / web / multi-LLM / user docs) | ✗ **Missing entirely** |
| **Per-component research for range, mean, SD** | ✗ **Missing entirely** |
| **AI proposes; user edits each node before MC runs** | Partial — NodeEditor exists but only opens after MC has already run |
| **Process with the actual model (MC + Bayes + sensitivity + calibration)** | ✓ math exists; not wired to the semantic-pipeline output |
| **Audit trail per component** (source: clarifying answer / literature / LLM / user) | Partial — `source` field exists (M8-02/M8-08) but only with 3 values; no citation flow |

## The user-confirmed scope of the realignment

From the AskUserQuestion answers in the 2026-05-19 session:

1. **Step 1 (clarifying):** "PROCEED with all in parallel" — meaning: do all three patterns simultaneously (LLM asks clarifying questions inline, LLM surfaces gaps, AND LLM proposes component list first for user review/edit). Not pick one — implement all three as available modes / phases.

2. **Step 2 (research source):** "all of 2, 3, 4" — meaning: LLM's own prior with reasoning shown AND web search retrieval (with citations) AND user-uploaded reference documents (RAG-style) AND iterative LLM ensemble per component. All four research-source mechanisms.

3. **Step 3 (output):** "We had many more models than just monte-carlo, look again." — engine must be extended. The hometier code shows: path-dependent multi-year MC, Triangular + Bernoulli mixture distributions, "impact" tags, scoring-rule calibration. The 6 Principles imply: reliability diagrams. The R6-04 sidecar implies: ensemble forecasting can be invoked as a node-fill mechanism. R6-07 (deferred) implies: multi-LLM consensus as a research mechanism.

4. **Step 4 (scope cleanup):** "Keep them all, just add the semantic mode alongside" — Forecast Mode, Multi-Proposer, Real Data Mode all stay. Semantic Mode becomes a new fifth mode.

## What is honestly required (not what's easy)

This is not a "small feature" — it's a separate product surface that uses the existing engine and adds substantial new machinery:

### Phase A — Semantic conversation surface (new)
- **A1.** New mode tab "Semantic" / "Build" with chat-style UI (not a single input bar).
- **A2.** Multi-turn conversation state machine: ASK → ANSWER → PROPOSE → REVIEW → RESEARCH → REVIEW → MODEL → RESULT.
- **A3.** Each phase emits structured intermediate state (clarifying Q&A pairs, component list, per-component research bundles) — all persisted so the user can navigate back/edit/restart.

### Phase B — Per-component research mechanisms
- **B1.** LLM-with-reasoning: same LLM call as today but per-component, with explicit "why this distribution / why these numbers" extraction.
- **B2.** Web search tool integration: a real search provider (Brave / Tavily / Bing). Citations as URLs in `sourceNote`.
- **B3.** RAG: user uploads reference PDFs / spreadsheets; per-component retrieval pulls supporting passages with citations.
- **B4.** Per-component multi-LLM consensus: query N LLMs per component for distribution/range/mean; surface disagreement as the uncertainty.

### Phase C — Engine extensions
- **C1.** Triangular distribution sampler in `lib/engine/distributions.ts`.
- **C2.** Bernoulli mixture / probabilistic event gate (composable, e.g. "this node fires with probability 0.12; if it fires, value is Lognormal(14500, 9800)").
- **C3.** Path-dependent / multi-year simulation support (loop with state carryover, like hometier's 30-year drawdown).
- **C4.** Node `impact` metadata (low / medium / high / critical) — surfaces in UI prioritization.
- **C5.** Reliability diagram in calibration UI (Principle 4 made real).
- **C6.** Brier score computation against recorded calibration outcomes.

### Phase D — Provenance hardening
- **D1.** Extend `NodeSource` from 3 values to a richer model: per-node provenance becomes `{primary: 'literature'|'llm_prior'|'web_search'|'rag_document'|'multi_llm_consensus'|'user_override', citations: [{source, url, snippet}], confidence: number}`.
- **D2.** Audit-event types for each research step (`semantic_clarify`, `semantic_research_web`, `semantic_research_rag`, `semantic_research_consensus`).
- **D3.** Save/load support for the full conversation state, not just the final graph.

## Honest cost / risk assessment

- This is **larger** than R6-04 + R6-05 + R6-06 combined. It's a new product surface, not a polish round.
- Phase A alone is ~2-3 weeks of focused work for a senior engineer.
- Web search and RAG integrations (B2, B3) require API keys for external services not currently in the project (Brave / Tavily for search; embedding service + vector store for RAG).
- The 4 research mechanisms (B1-B4) must be wired so the user can pick which to run per component; doing all 4 by default would be prohibitively expensive per question.
- Path-dependent simulation (C3) is a significant engine rewrite — current `dag-executor.ts` is single-shot.

## What I propose to do FIRST (before any code)

1. Show this document to the user. Confirm it matches what they remember.
2. Discuss which of A / B / C / D phases ship in what order.
3. Identify which existing modes (Forecast / Multi-Proposer) can plug into the semantic pipeline as research mechanisms rather than living as standalone tabs.
4. Decide whether the original PE / hometier example domains should drive the first MVP, or whether finESS stays domain-agnostic.
5. Write a real implementation plan with phased commit boundaries — NOT spin up agents.
