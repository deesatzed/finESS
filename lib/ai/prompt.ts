import medicalDiagnosticExample from "./examples/medical-diagnostic.json";
import businessRunwayExample from "./examples/business-runway.json";
import climateRiskExample from "./examples/climate-risk.json";

/**
 * Few-shot example loaded from a JSON file. The `keywords` array drives
 * selection; `userQuery` and `response` are pasted verbatim into the
 * system prompt when selected.
 */
export interface PromptExample {
  domain: string;
  keywords: string[];
  userQuery: string;
  response: unknown;
}

export const PROMPT_EXAMPLES: ReadonlyArray<PromptExample> = [
  medicalDiagnosticExample as PromptExample,
  businessRunwayExample as PromptExample,
  climateRiskExample as PromptExample,
];

const SYSTEM_PROMPT_BASE = `You are an expert uncertainty modeler. Given a user's decision problem described in natural language, you build a probabilistic uncertainty graph.

## Your Task

Identify the key uncertain factors in the user's problem, and model each as a node in an uncertainty graph. Then define edges that specify how nodes combine into a final output probability or value.

## Output Format

Return a single JSON object matching this schema:

{
  "nodes": [
    {
      "id": "unique_snake_case_id",
      "name": "Human-readable Name",
      "description": "What this node represents and why it matters",
      "distribution": "beta" | "normal" | "uniform" | "lognormal",
      "mean": 0.5,
      "sd": 0.1,
      "range": [0.0, 1.0],
      "unit": "%" | "pp" | "$" | "years" | etc,
      "group": "optional_group_name",
      "source": "literature" | "llm_prior" | "user_override",   // optional; defaults to "llm_prior" if omitted
      "sourceNote": "optional one-line citation or note"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "node_id",
      "target": "intermediate_or_output_id",
      "method": "additive" | "subtractive" | "bayesian_update" | "multiplicative",
      "label": "Optional explanation"
    }
  ],
  "outputNodeId": "the_final_output_node_id",
  "threshold": 0.3,
  "narration": "A paragraph explaining the reasoning, including where experts disagree and what that means for uncertainty."
}

## Edge Methods

- **additive**: Values are summed (e.g., base probability + risk modifiers)
- **subtractive**: Value is subtracted from target's existing value (e.g., lab noise reducing specificity)
- **bayesian_update**: Bayesian update using pre-test probability, sensitivity, and specificity. The target must receive:
  - Additive edges providing the pre-test probability
  - bayesian_update edges providing sensitivity (first) and specificity (second)
- **multiplicative**: Values are multiplied together

## Critical Rules

1. Create 4-8 nodes for a rich decomposition. Never just 2-3 flat nodes.
2. When experts disagree on a value, THAT disagreement IS the uncertainty. Set the SD to capture the range of expert opinions. Mention this in the narration.
3. Use intermediate composition nodes when inputs combine before feeding into the output (e.g., "pre_test_composed" for additive pre-test factors).
4. The "subtractive" method is for real effects (e.g., lab variability reducing test specificity). Don't confuse with negative additive values.
5. Always explain in the narration what the biggest sources of uncertainty are and what the user could do to reduce them.
6. For probabilities, use beta distributions. For modifiers/adjustments, use normal. For highly skewed values, use lognormal.
7. When a node's mean/SD comes from cited research, set "source" to "literature" and put the citation in "sourceNote". Otherwise omit "source" (it will default to "llm_prior") so downstream UI can distinguish prior estimates from evidenced ones.
8. Every node's mean must lie inside its range. Every edge source must reference a declared node id or another edge's target id. The outputNodeId must be declared as a node or be a target of at least one edge. A target that uses bayesian_update needs at least 2 bayesian_update edges (for sensitivity and specificity) AND either an additive pre-test edge OR a third bayesian_update edge providing the prior.

## Important

- Return ONLY the JSON object, no markdown fences or explanation outside the JSON.
- The outputNodeId should reference a virtual node that is the target of the final computation edges.
- Ensure all edge source IDs reference actual node IDs from your nodes array, or intermediate composition node IDs that are targets of other edges.
`;

/**
 * Tokenize a user query into lowercase word stems for keyword matching.
 * Strips punctuation; preserves hyphens inside terms (e.g. "pre-test").
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Score an example's keyword overlap with the query.
 * Counts each example keyword that appears as a substring of any query token
 * OR appears as a multi-word phrase substring of the original lowercase query.
 */
export function scoreExample(query: string, example: PromptExample): number {
  const lowerQuery = query.toLowerCase();
  const queryTokens = new Set(tokenize(query));
  let score = 0;
  for (const keyword of example.keywords) {
    const lowerKeyword = keyword.toLowerCase();
    if (lowerKeyword.includes(" ") || lowerKeyword.includes("-")) {
      if (lowerQuery.includes(lowerKeyword)) score += 1;
    } else {
      if (queryTokens.has(lowerKeyword)) score += 1;
    }
  }
  return score;
}

/**
 * Pick the example with the highest keyword overlap.
 * Returns null if no example scores above zero (no domain match → no example).
 * Ties broken deterministically by domain order in PROMPT_EXAMPLES.
 */
export function selectExample(
  query: string,
  examples: ReadonlyArray<PromptExample> = PROMPT_EXAMPLES
): PromptExample | null {
  let best: PromptExample | null = null;
  let bestScore = 0;
  for (const example of examples) {
    const score = scoreExample(query, example);
    if (score > bestScore) {
      bestScore = score;
      best = example;
    }
  }
  return best;
}

/**
 * Build the system prompt for a given query.
 * If the query matches a known domain, includes that domain's worked example
 * as few-shot guidance. If no domain matches, the prompt has no example —
 * which surfaces the LLM's uninstructed prior rather than biasing it toward
 * a familiar template.
 */
export function buildSystemPrompt(query: string): string {
  const example = selectExample(query);
  if (example === null) return SYSTEM_PROMPT_BASE;

  return `${SYSTEM_PROMPT_BASE}
## Worked Example

User: "${example.userQuery}"

Response:
${JSON.stringify(example.response, null, 2)}
`;
}

/**
 * Build the user message for the AI pipeline.
 */
export function buildUserMessage(query: string): string {
  return `Analyze this decision problem and build an uncertainty graph:\n\n${query}`;
}

/**
 * @deprecated Use buildSystemPrompt(query). Kept temporarily so any out-of-tree
 * importers don't break; the route handler now calls buildSystemPrompt directly.
 * Returns the medical-diagnostic example to preserve historical behavior.
 */
export const SYSTEM_PROMPT = buildSystemPrompt(
  "patient diagnosis pulmonary embolism d-dimer"
);
