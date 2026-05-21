/**
 * A5 follow-up + B6: server-side auto-advance for the semantic conversation.
 *
 * After the user's typed event lands in a state that REQUIRES an
 * adapter call, the server fires the adapter and applies the resulting
 * event before responding. That way one client PATCH produces a fully-
 * advanced state — the client never has to know the adapter exists.
 *
 * Auto-advance handles three state transitions today:
 *
 *  - CLARIFYING                → A3 clarifying-questions adapter.
 *  - PROPOSING_COMPONENTS      → A4 component-proposal adapter.
 *  - RESEARCHING + a fresh
 *    startResearch event       → the appropriate B1-B7 research adapter,
 *                                dispatched per the event's mechanism.
 *
 * Design choices:
 *
 *  - Auto-advance is opt-in PER STATE. Anything else is returned to the
 *    client unchanged.
 *
 *  - On adapter failure we dispatch the `fail` event so the state machine
 *    moves to ERROR with the source state preserved (so `back()` recovers).
 *    For RESEARCHING failures we apply a synthetic `researchReceived`
 *    that fast-forwards in-flight back to empty AND immediately a fail
 *    event so the conversation lands in ERROR but the inFlight set is
 *    cleared first. We do NOT throw — the conversation must remain
 *    navigable.
 *
 *  - The adapters themselves go through lib/ai/openrouter-client.ts which
 *    already enforces timeout, single retry, and per-call cost ceiling.
 *
 *  - Audit events for the auto-advance side-effects are emitted by the
 *    caller (the API route), not here. This module is pure-ish — it
 *    returns the new state + a description of what it did; the route
 *    decides how to log it.
 *
 *  - Mechanism-specific inputs (CSV rows, expert estimates) ride on the
 *    triggering startResearch event's `inputs` field. The reducer drops
 *    them on the floor (decision #4 in state-machine.ts); this dispatcher
 *    reads them via `event.inputs`. The original event is passed in via
 *    the new `triggerEvent` option — only used for the RESEARCHING path.
 *
 *  - Multi-mechanism toggle (concurrent research with cross-mechanism
 *    disagreement surfaced to the user) is deferred to Phase D per B6
 *    decision #5. Today: one mechanism per component, one accepted
 *    bundle.
 */

import {
  reduce,
  SemanticStateError,
  type SemanticEvent,
  type SemanticState,
  type StartResearchInputs,
} from "@/lib/semantic/state-machine";
import { requestClarifications, ClarifyError } from "@/lib/semantic/clarify";
import {
  proposeComponents,
  ProposeComponentsError,
} from "@/lib/semantic/propose-components";
import type {
  ResearchBundle,
  ResearchMechanism,
} from "@/lib/semantic/types";
import { bundleToNode } from "@/lib/semantic/bundle-to-node";
import { runSimulation } from "@/lib/engine/monte-carlo";
import { computeSensitivity } from "@/lib/engine/sensitivity";
import type { UncertaintyGraph } from "@/lib/types";
import {
  researchLlmPrior,
  LlmPriorResearchError,
} from "@/lib/semantic/research/llm-prior";
import {
  researchWeb,
  WebResearchError,
} from "@/lib/semantic/research/web";
import {
  runRagResearch,
  RagResearchError,
} from "@/lib/semantic/research/rag";
import {
  researchConsensus,
  ConsensusResearchError,
} from "@/lib/semantic/research/consensus";
import {
  researchForecast,
  ForecastResearchError,
} from "@/lib/semantic/research/forecast";
import {
  researchEmpirical,
  EmpiricalResearchError,
} from "@/lib/semantic/research/empirical";
import {
  researchExpertPanel,
  ExpertPanelError,
} from "@/lib/semantic/research/expert-panel";

export interface AutoAdvanceOptions {
  /** OpenRouter model id (caller-supplied; do NOT hardcode). */
  model: string;
  /** OpenRouter API key. */
  apiKey: string;
  /** Optional timeout override forwarded to callChat. */
  timeoutMs?: number;
  /** Optional cost-ceiling override forwarded to callChat. */
  costBudgetUsd?: number;
  /**
   * B6: per-research-step cost ceiling. Defaults to $0.05 to match the
   * project-wide per-call cap. Multi-LLM consensus may exceed this if
   * the caller raises it; the value is forwarded to the underlying
   * adapter where applicable.
   */
  researchCostBudgetUsd?: number;
  /** Tavily API key for web-search research. */
  tavilyApiKey?: string;
  /**
   * Workspace id used by RAG research to scope LanceDB queries. The
   * route handler supplies this from the authenticated session.
   */
  workspaceId?: string;
  /**
   * Consensus mechanism: the list of models to fan out to. The route
   * resolves these from OPENROUTER_MODELS so the user is in control of
   * which set fires. If absent and consensus is requested, the adapter
   * call fails with a typed error (no silent fallback to a default).
   */
  consensusModels?: string[];
  /**
   * B6: the original event that triggered this PATCH. Auto-advance only
   * reads this on the RESEARCHING path — it carries the mechanism
   * choice and the optional mechanism-specific inputs. When provided
   * and the state is RESEARCHING with this component now in-flight,
   * the dispatcher fires the adapter immediately.
   */
  triggerEvent?: SemanticEvent;
}

export interface AutoAdvanceStep {
  /** The event that was applied (LLM-derived or the synthetic fail). */
  eventType: string;
  /** State kind before this step. */
  fromState: SemanticState["kind"];
  /** State kind after this step. */
  toState: SemanticState["kind"];
  /** Wall-clock latency of the underlying adapter call, when present. */
  latencyMs?: number;
  /** USD cost of the adapter call, when present. */
  costUsd?: number;
  /** True if this step terminated in ERROR via the fail event. */
  failed: boolean;
  /** B6: research mechanism that ran, when this step was a research dispatch. */
  mechanism?: ResearchMechanism;
  /** B6: componentId researched, when this step was a research dispatch. */
  componentId?: string;
  /** D2: number of citations returned by the research bundle (for audit). */
  citationCount?: number;
}

export interface AutoAdvanceResult {
  /** Final state after zero or more auto-advance steps. */
  state: SemanticState;
  /** One entry per auto-advance step actually executed (may be empty). */
  steps: AutoAdvanceStep[];
}

/**
 * Apply zero or more auto-advance steps to `state` until the state is
 * one that requires user input. Bounded by `maxSteps` (default 4) so a
 * misbehaving adapter sequence can't loop forever.
 */
export async function autoAdvance(
  initial: SemanticState,
  opts: AutoAdvanceOptions,
  maxSteps = 4,
): Promise<AutoAdvanceResult> {
  let state = initial;
  const steps: AutoAdvanceStep[] = [];

  // Only the first step consumes the triggerEvent — subsequent
  // auto-advance steps are driven entirely by the resulting state.
  let triggerEvent: SemanticEvent | undefined = opts.triggerEvent;

  for (let i = 0; i < maxSteps; i++) {
    const next = await advanceOnce(state, opts, triggerEvent);
    triggerEvent = undefined;
    if (next === null) break;
    steps.push(next.step);
    state = next.state;
    if (next.step.failed) break;
  }

  return { state, steps };
}

/**
 * Take one auto-advance step from `state`. Returns null when no further
 * auto-advance is appropriate (state requires user input or is terminal).
 */
async function advanceOnce(
  state: SemanticState,
  opts: AutoAdvanceOptions,
  triggerEvent: SemanticEvent | undefined,
): Promise<{ state: SemanticState; step: AutoAdvanceStep } | null> {
  switch (state.kind) {
    case "CLARIFYING":
      return runClarifying(state, opts);
    case "PROPOSING_COMPONENTS":
      return runProposing(state, opts);
    case "RESEARCHING":
      // Research only dispatches when the triggering event was a fresh
      // startResearch. Otherwise the state is RESEARCHING because the
      // user is still picking a mechanism for some other component, and
      // we should not loop.
      if (
        triggerEvent &&
        triggerEvent.type === "startResearch" &&
        triggerEvent.componentId in state.inFlight
      ) {
        return runResearch(state, opts, triggerEvent);
      }
      return null;
    case "MODELING":
      return runModeling(state);
    default:
      return null;
  }
}

async function runClarifying(
  state: Extract<SemanticState, { kind: "CLARIFYING" }>,
  opts: AutoAdvanceOptions,
): Promise<{ state: SemanticState; step: AutoAdvanceStep }> {
  try {
    const result = await requestClarifications({
      query: state.query,
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
    });
    const next = reduce(state, {
      type: "clarificationsReceived",
      questions: result.questions,
    });
    return {
      state: next,
      step: {
        eventType: "clarificationsReceived",
        fromState: "CLARIFYING",
        toState: next.kind,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        failed: false,
      },
    };
  } catch (err) {
    return applyFail(state, "CLARIFYING", err);
  }
}

async function runProposing(
  state: Extract<SemanticState, { kind: "PROPOSING_COMPONENTS" }>,
  opts: AutoAdvanceOptions,
): Promise<{ state: SemanticState; step: AutoAdvanceStep }> {
  try {
    const clarifications = state.questions.map((question) => ({
      question,
      answer: state.answers[question.id] ?? "",
    }));
    const result = await proposeComponents({
      query: state.query,
      clarifications,
      model: opts.model,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
    });
    const next = reduce(state, {
      type: "componentsReceived",
      components: result.components,
    });
    return {
      state: next,
      step: {
        eventType: "componentsReceived",
        fromState: "PROPOSING_COMPONENTS",
        toState: next.kind,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        failed: false,
      },
    };
  } catch (err) {
    return applyFail(state, "PROPOSING_COMPONENTS", err);
  }
}

/**
 * B6: dispatch research for one component using the mechanism the user
 * picked. The state must have the component in-flight (the reducer just
 * added it from the triggering startResearch event). On success applies
 * `researchReceived`. On failure applies a synthetic `researchReceived`
 * with a bundle marked as failed via reasoning text AND drops the
 * conversation into ERROR via a fail event so the operator sees the
 * problem; back() recovers to RESEARCHING with the in-flight cleared.
 *
 * IMPORTANT: We DO NOT silently fall back to llm_prior. The
 * honest-uncertainty contract requires surfacing the failure plainly.
 */
async function runResearch(
  state: Extract<SemanticState, { kind: "RESEARCHING" }>,
  opts: AutoAdvanceOptions,
  triggerEvent: SemanticEvent & { type: "startResearch" },
): Promise<{ state: SemanticState; step: AutoAdvanceStep }> {
  const { componentId, mechanism } = triggerEvent;
  const inputs = triggerEvent.inputs ?? {};
  const component = state.components.find((c) => c.id === componentId);
  if (!component) {
    // Defensive — the reducer would have thrown earlier.
    return applyFail(
      state,
      "RESEARCHING",
      new Error(`unknown component "${componentId}"`),
    );
  }

  const startedAt = Date.now();
  try {
    let bundle: ResearchBundle;
    let costUsd: number | undefined;
    switch (mechanism) {
      case "llm_prior": {
        const result = await researchLlmPrior({
          component,
          query: state.query,
          clarifications: state.questions.map((q) => ({
            question: q,
            answer: state.answers[q.id] ?? "",
          })),
          model: opts.model,
          apiKey: opts.apiKey,
          timeoutMs: opts.timeoutMs,
          costBudgetUsd: opts.researchCostBudgetUsd ?? opts.costBudgetUsd,
        });
        bundle = result.bundle;
        costUsd = result.costUsd;
        break;
      }
      case "web_search": {
        if (!opts.tavilyApiKey || opts.tavilyApiKey.trim() === "") {
          throw new Error(
            "Web search requires TAVILY_API_KEY; set it in the server env to use the web_search mechanism.",
          );
        }
        const result = await researchWeb({
          component,
          query: inputs.searchQuery ?? `${component.name} ${component.description}`,
          clarifications: state.questions.map((q) => ({
            question: q,
            answer: state.answers[q.id] ?? "",
          })),
          model: opts.model,
          apiKey: opts.apiKey,
          tavilyApiKey: opts.tavilyApiKey,
          searchMaxResults: inputs.searchMaxResults,
          timeoutMs: opts.timeoutMs,
          costBudgetUsd: opts.researchCostBudgetUsd ?? opts.costBudgetUsd,
        });
        bundle = result.bundle;
        costUsd = result.costUsd;
        break;
      }
      case "rag_document": {
        if (!opts.workspaceId || opts.workspaceId.trim() === "") {
          throw new Error(
            "RAG research requires an authenticated workspace; no workspaceId on the session.",
          );
        }
        bundle = await runRagResearch({
          workspaceId: opts.workspaceId,
          component: {
            id: component.id,
            name: component.name,
            description: component.description,
            suggestedDistribution: component.suggestedDistribution,
          },
          model: opts.model,
          apiKey: opts.apiKey,
          timeoutMs: opts.timeoutMs,
          costBudgetUsd: opts.researchCostBudgetUsd ?? opts.costBudgetUsd,
        });
        costUsd = (bundle as { costUsd?: number }).costUsd;
        break;
      }
      case "multi_llm_consensus": {
        const models = opts.consensusModels ?? [];
        if (models.length < 2) {
          throw new Error(
            "Multi-LLM consensus requires at least 2 configured models in OPENROUTER_MODELS.",
          );
        }
        const result = await researchConsensus({
          component,
          query: state.query,
          clarifications: state.questions.map((q) => ({
            question: q,
            answer: state.answers[q.id] ?? "",
          })),
          models,
          apiKey: opts.apiKey,
          timeoutMs: opts.timeoutMs,
          costBudgetUsd: opts.researchCostBudgetUsd ?? opts.costBudgetUsd,
        });
        if (!result.consensus) {
          throw new Error("Consensus mechanism returned no synthesized bundle.");
        }
        bundle = result.consensus;
        costUsd = result.totalCostUsd;
        break;
      }
      case "ensemble_forecast": {
        const required = validateForecastInputs(inputs);
        const result = await researchForecast({
          component,
          csvRows: required.csvRows,
          dateColumn: required.dateColumn,
          targetColumn: required.targetColumn,
          horizon: required.horizon,
        });
        bundle = result.bundle;
        break;
      }
      case "empirical_observation": {
        const required = validateEmpiricalInputs(inputs);
        const result = await researchEmpirical({
          component,
          csvRows: required.csvRows,
          targetColumn: required.targetColumn,
          threshold: inputs.threshold ?? null,
        });
        bundle = result.bundle;
        break;
      }
      case "expert_panel": {
        const required = validateExpertPanelInputs(inputs);
        const result = researchExpertPanel({
          component,
          estimates: required.estimates,
          labels: inputs.labels,
          distribution: inputs.distribution,
          hardBounds: inputs.hardBounds,
        });
        bundle = result.bundle;
        break;
      }
      default: {
        // Exhaustiveness: TS knows mechanism is one of the union; this
        // is defensive in case the validator drifts ahead of this file.
        const exhaustiveCheck: never = mechanism;
        throw new Error(`unsupported mechanism "${String(exhaustiveCheck)}"`);
      }
    }

    const next = reduce(state, {
      type: "researchReceived",
      componentId,
      bundle,
    });
    return {
      state: next,
      step: {
        eventType: "researchReceived",
        fromState: "RESEARCHING",
        toState: next.kind,
        latencyMs: Date.now() - startedAt,
        costUsd,
        failed: false,
        mechanism,
        componentId,
        citationCount: bundle.citations?.length ?? 0,
      },
    };
  } catch (err) {
    // Mechanism-failure path: surface plainly via fail event. We DO NOT
    // mutate inFlight via researchReceived because doing so would leave
    // a forged-bundle artifact in audit / persistence — the
    // honest-uncertainty contract requires the failure stay visible.
    const failResult = applyFail(state, "RESEARCHING", err);
    failResult.step.mechanism = mechanism;
    failResult.step.componentId = componentId;
    failResult.step.latencyMs = Date.now() - startedAt;
    return failResult;
  }
}

/**
 * P3: MODELING auto-advance — runs the Monte Carlo engine server-side.
 *
 * Converts every accepted ResearchBundle into a provenanced UncertaintyNode
 * via bundleToNode(), builds a flat UncertaintyGraph (all nodes independent,
 * a synthetic output node accumulates their means additively), runs the MC
 * simulation (10 000 samples), computes sensitivity, and applies
 * `modelComplete` with the results.
 *
 * Graph structure for the flat case: each bundle becomes a leaf node; a
 * synthetic `_output` node receives additive edges from all leaves. The
 * threshold from the conversation state is set on the graph so
 * pAboveThreshold is computed correctly. For single-component conversations
 * (common in tests) the leaf itself is the output node — no synthetic node
 * is needed.
 */
async function runModeling(
  state: Extract<SemanticState, { kind: "MODELING" }>,
): Promise<{ state: SemanticState; step: AutoAdvanceStep }> {
  const startedAt = Date.now();
  try {
    const nodes = state.components.map((component) => {
      const bundle = state.bundles[component.id];
      if (!bundle) {
        throw new Error(
          `No research bundle for component "${component.id}" ("${component.name}"). All components must be researched before running the model.`,
        );
      }
      return bundleToNode(bundle, component);
    });

    let graph: UncertaintyGraph;

    if (nodes.length === 1) {
      graph = {
        nodes,
        edges: [],
        outputNodeId: nodes[0].id,
        threshold: state.threshold,
      };
    } else {
      // Synthetic additive output node whose mean is the sum of all leaf means.
      const outputMean = nodes.reduce((s, n) => s + n.mean, 0);
      const outputSd = Math.sqrt(nodes.reduce((s, n) => s + n.sd * n.sd, 0));
      const outputNode = {
        id: "_semantic_output",
        name: "Combined output",
        description: "Additive combination of all research components",
        distribution: "normal" as const,
        mean: outputMean,
        sd: Math.max(outputSd, 0.001),
        range: [outputMean - 3 * outputSd, outputMean + 3 * outputSd] as [number, number],
        unit: "",
        source: "llm_prior" as const,
      };
      graph = {
        nodes: [...nodes, outputNode],
        edges: nodes.map((n) => ({
          id: `edge_${n.id}_output`,
          source: n.id,
          target: "_semantic_output",
          method: "additive" as const,
        })),
        outputNodeId: "_semantic_output",
        threshold: state.threshold,
      };
    }

    const config = { numSamples: 10_000, batchSize: 1_000 };
    const simResult = runSimulation(graph, config);
    const sensitivityResults = computeSensitivity(graph, config);

    // Top sensitivity component: the leaf node (excluding the synthetic output)
    // with the highest varianceReduction.
    const topSensitivity = sensitivityResults
      .filter((r) => r.nodeId !== "_semantic_output")
      .sort((a, b) => b.varianceReduction - a.varianceReduction)[0];

    const modelResult = {
      topSensitivityComponentId: topSensitivity?.nodeId,
      pAboveThreshold: simResult.pAboveThreshold,
      raw: {
        mean: simResult.mean,
        median: simResult.median,
        ciLow: simResult.ciLow,
        ciHigh: simResult.ciHigh,
        seed: simResult.seed,
        sensitivity: sensitivityResults,
      },
    };

    const next = reduce(state, { type: "modelComplete", result: modelResult });
    return {
      state: next,
      step: {
        eventType: "modelComplete",
        fromState: "MODELING",
        toState: next.kind,
        latencyMs: Date.now() - startedAt,
        failed: false,
      },
    };
  } catch (err) {
    return applyFail(state, "MODELING", err);
  }
}

// ---------------------------------------------------------------------------
// Mechanism-specific input validators (required-field enforcement). These
// throw plain Error instances; the catch in runResearch maps them to a
// fail event.
// ---------------------------------------------------------------------------

function validateForecastInputs(
  inputs: StartResearchInputs,
): {
  csvRows: Array<Record<string, string | number>>;
  dateColumn: string;
  targetColumn: string;
  horizon: 1 | 2 | 3;
} {
  if (!inputs.csvRows || inputs.csvRows.length === 0) {
    throw new Error(
      "Forecast research requires csvRows (upload or paste a CSV first).",
    );
  }
  if (!inputs.dateColumn) {
    throw new Error("Forecast research requires inputs.dateColumn.");
  }
  if (!inputs.targetColumn) {
    throw new Error("Forecast research requires inputs.targetColumn.");
  }
  const horizon = inputs.horizon ?? 1;
  if (horizon !== 1 && horizon !== 2 && horizon !== 3) {
    throw new Error(
      `Forecast research requires inputs.horizon in {1, 2, 3} (got ${horizon}).`,
    );
  }
  return {
    csvRows: inputs.csvRows,
    dateColumn: inputs.dateColumn,
    targetColumn: inputs.targetColumn,
    horizon: horizon as 1 | 2 | 3,
  };
}

function validateEmpiricalInputs(
  inputs: StartResearchInputs,
): {
  csvRows: Array<Record<string, string | number>>;
  targetColumn: string;
} {
  if (!inputs.csvRows || inputs.csvRows.length === 0) {
    throw new Error(
      "Real-data research requires csvRows (upload or paste a CSV first).",
    );
  }
  if (!inputs.targetColumn) {
    throw new Error("Real-data research requires inputs.targetColumn.");
  }
  return { csvRows: inputs.csvRows, targetColumn: inputs.targetColumn };
}

function validateExpertPanelInputs(
  inputs: StartResearchInputs,
): { estimates: number[] } {
  if (!inputs.estimates || inputs.estimates.length < 2) {
    throw new Error(
      "Expert-panel research requires at least 2 numeric estimates in inputs.estimates.",
    );
  }
  return { estimates: inputs.estimates };
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

function applyFail(
  state: SemanticState,
  fromKind: SemanticState["kind"],
  err: unknown,
): { state: SemanticState; step: AutoAdvanceStep } {
  const message = describeError(err);
  // The reducer's `fail` is a universal transition from any non-terminal
  // state, so this is always safe.
  const next = reduce(state, { type: "fail", message });
  return {
    state: next,
    step: {
      eventType: "fail",
      fromState: fromKind,
      toState: next.kind,
      failed: true,
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof ClarifyError) {
    return `Clarifying step failed (${err.code}): ${err.message}`;
  }
  if (err instanceof ProposeComponentsError) {
    return `Component proposal failed (${err.code}): ${err.message}`;
  }
  if (err instanceof LlmPriorResearchError) {
    return `LLM-prior research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof WebResearchError) {
    return `Web-search research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof RagResearchError) {
    return `RAG research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof ConsensusResearchError) {
    return `Consensus research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof ForecastResearchError) {
    return `Forecast research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof EmpiricalResearchError) {
    return `Real-data research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof ExpertPanelError) {
    return `Expert-panel research failed (${err.code}): ${err.message}`;
  }
  if (err instanceof SemanticStateError) {
    return `State machine refused the adapter result: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
