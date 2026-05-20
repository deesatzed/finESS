/**
 * Semantic Mode — A4: Component-identification step.
 *
 * Given (a) the user's natural-language query and (b) the clarifying Q&A
 * pairs collected in A3, asks the configured LLM to propose 4-10
 * components. A component is one uncertain factor that materially affects
 * the output — NOT a full uncertainty graph node. The LLM returns:
 *
 *   {id, name, description, suggestedDistribution, why, dependsOn?: string[]}
 *
 * Critically, this step does NOT produce mean / sd / range / mode values
 * — those are the responsibility of Phase B research mechanisms
 * (lib/semantic/research/*). The suggestedDistribution is a hint so the
 * downstream research call can default to the right distribution family.
 *
 * Why we require at least one clarifying Q&A pair before this call:
 *   Empirically (v2 plan change-row 6), proposing components straight from
 *   a raw query produced flat 3-component decompositions. The clarifying
 *   answers anchor the LLM to the domain, the segment, and the unit-of-
 *   analysis. Calling this function without clarifications is a consumer
 *   bug, not a graceful path — we surface it with EMPTY_CLARIFICATIONS.
 *
 * Every LLM call goes through `lib/ai/openrouter-client.callChat` so
 * per-call timeout / retry / cost ceiling are enforced uniformly. The
 * model id is always supplied by the caller — no model versions hard-
 * coded here (workspace rule).
 */

import {
  callChat,
  OpenRouterCallError,
  type CallChatOptions,
} from "@/lib/ai/openrouter-client";
import type {
  ClarifyingQuestion,
  ProposedComponent,
  SemanticDistribution,
} from "@/lib/semantic/types";
import componentProposalExamples from "@/lib/ai/examples/component-proposal-examples.json";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ProposeComponentsOptions {
  query: string;
  clarifications: Array<{ question: ClarifyingQuestion; answer: string }>;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  costBudgetUsd?: number;
  /** Test-harness injection only; production code passes nothing. */
  fetchImpl?: CallChatOptions["fetchImpl"];
}

export interface ProposeComponentsResult {
  components: ProposedComponent[];
  model: string;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
}

export type ProposeComponentsErrorCode =
  | "EMPTY_QUERY"
  | "EMPTY_CLARIFICATIONS"
  | "INVALID_RESPONSE"
  | "TOO_FEW_COMPONENTS"
  | "TOO_MANY_COMPONENTS"
  | "INVALID_DISTRIBUTION"
  | "UNKNOWN_DEPENDENCY"
  | "DUPLICATE_COMPONENT_ID"
  | "OPENROUTER_ERROR";

export class ProposeComponentsError extends Error {
  readonly code: ProposeComponentsErrorCode;
  constructor(message: string, code: ProposeComponentsErrorCode) {
    super(message);
    this.name = "ProposeComponentsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/**
 * The only distribution families the engine knows how to sample. C1 added
 * triangular; C2's Bernoulli mixture is a separate node attribute (`gate`),
 * not a distribution family — so it does NOT appear here.
 */
const VALID_DISTRIBUTIONS: ReadonlyArray<SemanticDistribution> = [
  "beta",
  "normal",
  "uniform",
  "lognormal",
  "triangular",
];

const MIN_COMPONENTS = 4;
const MAX_COMPONENTS = 10;
const DEFAULT_TEMPERATURE = 0.4;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

interface ComponentProposalExampleFile {
  examples: Array<{
    domain: string;
    userQuery: string;
    clarifications: Array<{ question: string; answer: string }>;
    response: { components: ProposedComponent[] };
  }>;
}

const EXAMPLES = (componentProposalExamples as ComponentProposalExampleFile)
  .examples;

const SYSTEM_PROMPT_BASE = `You are an expert uncertainty-modeling assistant for finESS.

The user has asked a question and answered your clarifying questions.
Now identify the ${MIN_COMPONENTS} to ${MAX_COMPONENTS} KEY COMPONENTS whose individual uncertainty
shapes the answer.

A component is one uncertain factor. Examples:
- "growth_rate" (the monthly MRR growth percentage)
- "discount_rate" (the rate used to value future cashflows)
- "policy_change_p" (the probability of a tariff change)
- "supplier_lead_time" (weeks until parts arrive)

DO:
- Pick ${MIN_COMPONENTS}-${MAX_COMPONENTS} components. Fewer than ${MIN_COMPONENTS} produces a degenerate model; more
  than ${MAX_COMPONENTS} produces noise.
- Each component should be one quantity, not a sentence. Stable
  snake_case ids.
- Suggest a probability distribution family for each component:
    beta       -> bounded probabilities or fractions in [0, 1]
    normal     -> continuous quantities with symmetric uncertainty
    uniform    -> known min/max with no central tendency
    lognormal  -> positive quantities with right-skewed uncertainty
                 (costs, durations, sizes)
    triangular -> bounded quantities with a known most-likely value
                 (best/likely/worst-case planning estimates)
- Mark dependencies: if component A depends on component B, list B in
  A.dependsOn so the research step can order intelligently.
- For each, write a one-sentence WHY explaining its leverage on the
  output.

DO NOT:
- Propose ranges, means, or standard deviations yet — that comes from
  research in the next step.
- Reference statistical jargon in the descriptions (the user is
  non-statistical).
- Mix categorical labels into one component ("region" as a single
  component is wrong; break out per-region uncertainties).

Output strict JSON:
{
  "components": [
    {
      "id": "snake_case_id",
      "name": "Human-readable name",
      "description": "What this quantity is.",
      "suggestedDistribution": "beta" | "normal" | "uniform" | "lognormal" | "triangular",
      "why": "One sentence on why this matters for the answer.",
      "dependsOn": ["other_component_id"]
    }
  ]
}

Return ONLY the JSON object — no markdown fences, no prose before or after.
`;

/**
 * Build the system prompt by appending the worked example(s) to the base
 * instructions. Per v2 plan addendum, the worked example is MANDATORY:
 * without it, output regresses to flat 3-component decompositions.
 */
export function buildComponentProposalSystemPrompt(): string {
  if (EXAMPLES.length === 0) return SYSTEM_PROMPT_BASE;

  const exampleBlocks = EXAMPLES.map((ex) => {
    const clarLines = ex.clarifications
      .map((c) => `- ${c.question}\n  ${c.answer}`)
      .join("\n");
    return `WORKED EXAMPLE
Query: "${ex.userQuery}"

Clarifications:
${clarLines}

Expected response:
${JSON.stringify(ex.response, null, 2)}`;
  }).join("\n\n");

  return `${SYSTEM_PROMPT_BASE}\n${exampleBlocks}\n`;
}

/**
 * Build the user message that pairs the query with the formatted Q&A.
 */
export function buildComponentProposalUserMessage(
  query: string,
  clarifications: ProposeComponentsOptions["clarifications"],
): string {
  const qaLines = clarifications
    .map((pair) => `Q: ${pair.question.question}\nA: ${pair.answer}`)
    .join("\n\n");
  return `Query:\n${query}\n\nClarifying Q&A:\n${qaLines}\n\nPropose the component list now.`;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function parseAndValidate(rawContent: string): ProposedComponent[] {
  let cleaned = rawContent.trim();
  // Tolerate markdown fences in case the model ignores response_format.
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProposeComponentsError(
      `LLM response was not valid JSON: ${message}`,
      "INVALID_RESPONSE",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProposeComponentsError(
      "LLM response must be a JSON object",
      "INVALID_RESPONSE",
    );
  }

  const obj = parsed as Record<string, unknown>;
  const componentsRaw = obj.components;
  if (!Array.isArray(componentsRaw)) {
    throw new ProposeComponentsError(
      "LLM response must contain a 'components' array",
      "INVALID_RESPONSE",
    );
  }

  if (componentsRaw.length < MIN_COMPONENTS) {
    throw new ProposeComponentsError(
      `LLM returned ${componentsRaw.length} components; need at least ${MIN_COMPONENTS}`,
      "TOO_FEW_COMPONENTS",
    );
  }
  if (componentsRaw.length > MAX_COMPONENTS) {
    throw new ProposeComponentsError(
      `LLM returned ${componentsRaw.length} components; max is ${MAX_COMPONENTS}`,
      "TOO_MANY_COMPONENTS",
    );
  }

  const components: ProposedComponent[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < componentsRaw.length; i++) {
    const c = componentsRaw[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new ProposeComponentsError(
        `Component at index ${i} is not an object`,
        "INVALID_RESPONSE",
      );
    }
    const rec = c as Record<string, unknown>;

    if (typeof rec.id !== "string" || rec.id.trim() === "") {
      throw new ProposeComponentsError(
        `Component at index ${i} is missing a non-empty 'id'`,
        "INVALID_RESPONSE",
      );
    }
    const id = rec.id.trim();
    if (typeof rec.name !== "string" || rec.name.trim() === "") {
      throw new ProposeComponentsError(
        `Component '${id}' (index ${i}) is missing a non-empty 'name'`,
        "INVALID_RESPONSE",
      );
    }
    if (typeof rec.description !== "string" || rec.description.trim() === "") {
      throw new ProposeComponentsError(
        `Component '${id}' (index ${i}) is missing a non-empty 'description'`,
        "INVALID_RESPONSE",
      );
    }
    if (typeof rec.suggestedDistribution !== "string") {
      throw new ProposeComponentsError(
        `Component '${id}' (index ${i}) is missing 'suggestedDistribution'`,
        "INVALID_RESPONSE",
      );
    }
    if (typeof rec.why !== "string" || rec.why.trim() === "") {
      throw new ProposeComponentsError(
        `Component '${id}' (index ${i}) is missing a non-empty 'why'`,
        "INVALID_RESPONSE",
      );
    }

    if (
      !(VALID_DISTRIBUTIONS as ReadonlyArray<string>).includes(
        rec.suggestedDistribution,
      )
    ) {
      throw new ProposeComponentsError(
        `Component '${id}' has invalid suggestedDistribution '${rec.suggestedDistribution}'. Must be one of: ${VALID_DISTRIBUTIONS.join(", ")}`,
        "INVALID_DISTRIBUTION",
      );
    }

    if (seenIds.has(id)) {
      throw new ProposeComponentsError(
        `Duplicate component id '${id}'`,
        "DUPLICATE_COMPONENT_ID",
      );
    }
    seenIds.add(id);

    const out: ProposedComponent = {
      id,
      name: rec.name.trim(),
      description: rec.description.trim(),
      suggestedDistribution: rec.suggestedDistribution as SemanticDistribution,
      why: rec.why.trim(),
    };

    if (rec.dependsOn !== undefined) {
      if (!Array.isArray(rec.dependsOn)) {
        throw new ProposeComponentsError(
          `Component '${id}' has non-array 'dependsOn'`,
          "INVALID_RESPONSE",
        );
      }
      const deps: string[] = [];
      for (const d of rec.dependsOn) {
        if (typeof d !== "string" || d.trim() === "") {
          throw new ProposeComponentsError(
            `Component '${id}' has a non-string entry in 'dependsOn'`,
            "INVALID_RESPONSE",
          );
        }
        deps.push(d.trim());
      }
      out.dependsOn = deps;
    }

    components.push(out);
  }

  // dependsOn cross-reference: every referenced id must exist in the
  // component list. Self-references are also rejected.
  for (const c of components) {
    if (!c.dependsOn) continue;
    for (const dep of c.dependsOn) {
      if (dep === c.id) {
        throw new ProposeComponentsError(
          `Component '${c.id}' lists itself in dependsOn`,
          "UNKNOWN_DEPENDENCY",
        );
      }
      if (!seenIds.has(dep)) {
        throw new ProposeComponentsError(
          `Component '${c.id}' depends on unknown component '${dep}'`,
          "UNKNOWN_DEPENDENCY",
        );
      }
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function proposeComponents(
  opts: ProposeComponentsOptions,
): Promise<ProposeComponentsResult> {
  if (typeof opts.query !== "string" || opts.query.trim() === "") {
    throw new ProposeComponentsError(
      "proposeComponents requires a non-empty query",
      "EMPTY_QUERY",
    );
  }
  if (!Array.isArray(opts.clarifications) || opts.clarifications.length === 0) {
    throw new ProposeComponentsError(
      "proposeComponents requires at least one clarifying Q&A pair (calling without clarifications produces low-quality components)",
      "EMPTY_CLARIFICATIONS",
    );
  }

  const systemPrompt = buildComponentProposalSystemPrompt();
  const userMessage = buildComponentProposalUserMessage(
    opts.query,
    opts.clarifications,
  );

  let callResult;
  try {
    callResult = await callChat({
      model: opts.model,
      apiKey: opts.apiKey,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      responseFormat: { type: "json_object" },
      temperature: DEFAULT_TEMPERATURE,
      timeoutMs: opts.timeoutMs,
      costBudgetUsd: opts.costBudgetUsd,
      referer: "https://finess.app",
      title: "finESS Semantic Component Proposal",
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    if (err instanceof OpenRouterCallError) {
      throw new ProposeComponentsError(
        `OpenRouter call failed: ${err.code}${err.httpStatus !== undefined ? ` HTTP ${err.httpStatus}` : ""} (${err.message})`,
        "OPENROUTER_ERROR",
      );
    }
    throw err;
  }

  const components = parseAndValidate(callResult.content);

  return {
    components,
    model: callResult.model,
    latencyMs: callResult.latencyMs,
    costUsd: callResult.costUsd,
    retryCount: callResult.retryCount,
  };
}
