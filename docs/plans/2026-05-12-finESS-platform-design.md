# finESS Platform Design

**Date:** 2026-05-12
**Status:** Approved

## Vision

finESS is a platform where anyone — regardless of technical skill — can describe a decision they're facing in plain language, and AI builds an honest probabilistic model that shows them the full uncertainty landscape, not a single overconfident answer.

Users watch the system think in real-time: Monte Carlo simulations running live, distributions forming, nodes pulsing, gauges converging — like a mission control center for uncertainty.

## The 6 Principles (Foundation)

Every feature in finESS traces back to these:

1. **Distributions, not verdicts.** Every answer is a full probability distribution with credible intervals — never a single number.
2. **Expert disagreement becomes variance, not error.** When sources conflict, the disagreement is explicitly encoded as input uncertainty.
3. **AI estimates inputs; classical math propagates uncertainty.** AI parameterizes the nodes; Monte Carlo + Bayes does the propagation. Transparent, auditable.
4. **Calibration is the evaluation metric.** Users can feed back real outcomes to track whether the probabilities match reality over time.
5. **Sensitivity analysis tells you what to verify next.** Automatic ranking of which uncertain input would reduce output uncertainty the most.
6. **A wide interval is not failure; it is useful honesty.** The UI celebrates honesty and never hides uncertainty.

## Target User

Domain experts who are NOT coders: clinicians, financial analysts, engineers, lawyers, policy makers. They know their field deeply but should never need to understand beta distributions or Monte Carlo methods. AI handles the probabilistic modeling; they describe the problem and interpret the results.

## Core User Experience

### Input: Natural Language

The user describes their decision problem in plain English:

> "I'm a 55-year-old male with chest pain and shortness of breath. My D-dimer came back elevated. What's my risk of pulmonary embolism?"

> "I'm considering investing in a Series B climate tech startup. Revenue is $2M ARR growing 40% YoY. What's the probability this returns 5x in 5 years?"

> "We're designing a bridge with a 75-year design life. Soil reports show variable clay composition. What's the probability settlement exceeds 25mm?"

### Output: Immersive Live Dashboard

A multi-panel animated dashboard that shows the reasoning happening in real-time.

## Dashboard Layout (6 Panels)

### Panel 1 — Node Network (center, largest)
- Animated graph of uncertainty nodes
- Nodes pulse and glow as Monte Carlo samples flow through them
- Connection lines animate with "data particles" flowing from inputs through the reasoning chain to output
- Node size scales with contribution to final uncertainty (sensitivity)
- Color shifts: blue (low uncertainty) → amber → red (high uncertainty)
- Click any node to drill into its distribution

### Panel 2 — Live Distribution Formation (top right)
- The posterior distribution builds in real-time as samples accumulate
- Starts as noise, gradually resolves into a shape — like watching a Polaroid develop
- Credible interval bars sweep inward as confidence tightens
- The mean line stabilizes, overshoots, stabilizes — showing convergence

### Panel 3 — Sensitivity Radar
- Radar/spider chart with each axis = one uncertainty node
- Arms extend/contract in real-time as the engine discovers which nodes matter most
- Pulsing animation — the shape "breathes" as samples accumulate
- Final state = clear visual of where uncertainty lives

### Panel 4 — Uncertainty Gauges (analog dials)
- Circular gauge dials for key metrics:
  - Overall confidence level (how tight is the credible interval?)
  - Calibration score (how honest are the probabilities?)
  - Convergence (has the Monte Carlo stabilized?)
  - Decision clarity (is the answer actionable yet, or do we need more data?)
- Smooth needle animations — analog feel

### Panel 5 — Spectrum Bars (bottom)
- Horizontal bars showing each node's current distribution
- Each bar = a mini histogram that fills in real-time
- Color-coded by distribution type (beta = blue, normal = green, etc.)
- Width shows uncertainty range, brightness shows sample density

### Panel 6 — Plain Language Stream (sidebar)
- As the engine thinks, it narrates in real-time:
  - "Identifying 5 uncertainty factors..."
  - "Pre-test probability: experts disagree (10%-25%). Encoding as Beta distribution..."
  - "Running 15,000 simulations..."
  - "D-dimer specificity is driving 43% of output uncertainty..."
  - "Recommendation: CT angiogram would collapse uncertainty by 65%"

## Key Visual Moments

1. **The Build-Up:** Dashboard starts dark/empty. Nodes appear one by one as AI identifies factors. Then simulation launches and everything comes alive simultaneously.
2. **The Convergence:** 15,000 simulations condense from chaos into a clear signal. The moment the credible interval stabilizes is visually satisfying — like autofocus locking in.
3. **The Sensitivity Reveal:** After simulation completes, highest-uncertainty nodes pulse bright, and the "what to verify next" recommendation appears.
4. **The "What If":** Users drag any node's distribution (widen/narrow, shift mean) and watch the entire dashboard react in real-time. Live re-propagation.

## AI Engine Pipeline

### Step 1 — Intent Parsing
User describes their problem in natural language. AI (LLM) extracts:
- The decision being made
- The domain (clinical, financial, engineering, legal, policy, etc.)
- The key uncertain factors
- Available evidence or data the user provides

### Step 2 — Node Generation
AI builds the uncertainty graph:
- Each factor becomes a node with: distribution type, mean, SD, plausible range, source citation
- Reasoning chain: how nodes combine (Bayesian update, additive, multiplicative, etc.)
- All assumptions surfaced and editable by the user

### Step 3 — Live Simulation
Monte Carlo engine runs in the browser (WebAssembly or Web Workers):
- Streams samples to the dashboard in real-time
- Each sample flows visually through the node network
- All panels update progressively

### Step 4 — Analysis & Narration
After convergence:
- Sensitivity analysis identifies highest-leverage nodes
- Plain-language recommendation generated
- Calibration tracking available when outcomes are fed back

## Domain Examples

### Clinical
"My patient has an elevated troponin, atypical chest pain, and diabetes. What's the probability of acute MI vs. unstable angina?"

Nodes: pre-test prevalence, troponin sensitivity/specificity, ECG findings, risk factor modifiers

### Financial
"I'm considering investing in a Series B startup in the climate tech space. Revenue is $2M ARR growing 40% YoY. What's the probability this returns 5x in 5 years?"

Nodes: base rate of Series B success, sector modifier, team quality prior, revenue growth sustainability, market size uncertainty

### Engineering
"We're designing a bridge with a 75-year design life. Soil reports show variable clay composition. What's the probability the foundation settlement exceeds 25mm?"

Nodes: soil bearing capacity distribution, load uncertainty, climate/seismic factors, material degradation rates

### Legal
"We have a patent infringement case. Prior art is ambiguous, claims are moderately broad, defendant has strong counsel. Probability of favorable judgment?"

Nodes: prior art strength, claim breadth interpretation, judge/venue tendencies, opposing counsel effectiveness

### Policy
"If we implement a carbon tax at $50/ton, what's the probability of achieving 30% emissions reduction by 2035?"

Nodes: price elasticity of energy demand, technology substitution rates, compliance rates, economic growth assumptions

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | Next.js 14 + TypeScript | SSR, fast, workspace standard |
| Visualization | D3.js + WebGL (or Three.js) | Real-time animation at dashboard density |
| Monte Carlo engine | Web Workers (JS) or WebAssembly (Rust) | Browser-native, no server round-trip for simulation |
| AI / LLM | User-selected model via OpenRouter | Intent parsing, node generation, narration |
| Data persistence | PostgreSQL + Prisma | Save models, track calibration over time |
| Calibration store | PostgreSQL | Outcome feedback loop for Principle 4 |
| Styling | Tailwind CSS | Dark theme, responsive, consistent with viz aesthetic |

## User Interaction Model

1. **Describe** — Type or speak the decision problem
2. **Watch** — AI identifies nodes, simulation runs live across all panels
3. **Explore** — Click nodes, drag distributions, ask follow-up questions
4. **Act** — Read the sensitivity recommendation ("verify X next"), export the analysis
5. **Learn** — Feed back outcomes, watch calibration improve over time

## What Makes This Novel

- Most AI gives you a single confident answer. finESS shows you the full uncertainty landscape.
- Most probabilistic tools require statistical expertise. finESS requires only natural language.
- Most dashboards show static results. finESS shows the reasoning process live, like watching a brain think.
- The sensitivity analysis isn't just informative — it's prescriptive: "Here's the single most valuable thing you could learn next."

## Success Criteria

- A domain expert with zero statistical training can describe a problem and get an honest probabilistic analysis within 30 seconds
- The live dashboard is visually compelling enough that users watch the full simulation (not skip to results)
- Sensitivity analysis produces actionable "what to verify next" recommendations in every domain
- Calibration tracking demonstrably improves over time when outcomes are fed back
