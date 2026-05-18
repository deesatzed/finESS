import type {
  UncertaintyGraph,
  UncertaintyNode,
  CombinationMethod,
  NodeSource,
} from "@/lib/types";

const VALID_METHODS: CombinationMethod[] = [
  "additive",
  "subtractive",
  "bayesian_update",
  "multiplicative",
];

const VALID_DISTRIBUTIONS = ["beta", "normal", "uniform", "lognormal"];

/**
 * Sources that we accept verbatim from the model/persisted graph.
 * Anything else (missing, null, unknown string) is normalized to "llm_prior"
 * so downstream UI / aggregation code can safely treat node.source as set.
 */
const PRESERVED_SOURCES: ReadonlyArray<NodeSource> = [
  "literature",
  "user_override",
];

/**
 * Parse and validate an AI response into an UncertaintyGraph.
 * Throws descriptive errors on invalid input.
 */
export function parseAIResponse(raw: string): UncertaintyGraph {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI response is not valid JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AI response must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Validate nodes
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new Error("AI response must contain a non-empty 'nodes' array");
  }

  for (const node of obj.nodes) {
    validateNode(node);
  }

  // Validate edges
  if (!Array.isArray(obj.edges) || obj.edges.length === 0) {
    throw new Error("AI response must contain a non-empty 'edges' array");
  }

  for (const edge of obj.edges) {
    validateEdge(edge);
  }

  // Validate outputNodeId
  if (typeof obj.outputNodeId !== "string" || obj.outputNodeId === "") {
    throw new Error("AI response must have a non-empty 'outputNodeId'");
  }

  validateGraphSemantics(
    obj.nodes as Array<{ id: string; mean: number; range: [number, number] }>,
    obj.edges as Array<{ id: string; source: string; target: string; method: CombinationMethod }>,
    obj.outputNodeId as string
  );

  const normalizedNodes = (obj.nodes as Array<Record<string, unknown>>).map(
    normalizeNode
  );

  return {
    nodes: normalizedNodes,
    edges: obj.edges as UncertaintyGraph["edges"],
    outputNodeId: obj.outputNodeId as string,
    threshold: typeof obj.threshold === "number" ? obj.threshold : undefined,
    narration: typeof obj.narration === "string" ? obj.narration : undefined,
  };
}

function validateGraphSemantics(
  nodes: Array<{ id: string; mean: number; range: [number, number] }>,
  edges: Array<{ id: string; source: string; target: string; method: CombinationMethod }>,
  outputNodeId: string
): void {
  const declaredNodeIds = new Set(nodes.map((n) => n.id));
  const edgeTargets = new Set(edges.map((e) => e.target));
  const validSources = new Set<string>(declaredNodeIds);
  for (const e of edges) validSources.add(e.target);

  for (const n of nodes) {
    if (n.range[0] > n.range[1]) {
      throw new Error(
        `Node '${n.id}' has inverted range [${n.range[0]}, ${n.range[1]}]`
      );
    }
    if (n.mean < n.range[0] || n.mean > n.range[1]) {
      throw new Error(
        `Node '${n.id}' has mean ${n.mean} outside range [${n.range[0]}, ${n.range[1]}]`
      );
    }
  }

  for (const e of edges) {
    if (!validSources.has(e.source)) {
      throw new Error(`Edge '${e.id}' references unknown source '${e.source}'`);
    }
  }

  if (!declaredNodeIds.has(outputNodeId) && !edgeTargets.has(outputNodeId)) {
    throw new Error(
      `outputNodeId '${outputNodeId}' is unreachable: not a declared node and not a target of any edge`
    );
  }

  const methodsByTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (!methodsByTarget.has(e.target)) methodsByTarget.set(e.target, []);
    methodsByTarget.get(e.target)!.push(e.method);
  }
  for (const [target, methods] of methodsByTarget) {
    if (!methods.includes("bayesian_update")) continue;
    const bayesCount = methods.filter((m) => m === "bayesian_update").length;
    const additiveCount = methods.filter((m) => m === "additive").length;
    if (bayesCount < 2) {
      throw new Error(
        `Target '${target}' uses bayesian_update but has only ${bayesCount} bayesian_update edges (need at least 2 for sensitivity and specificity)`
      );
    }
    if (additiveCount === 0 && bayesCount < 3) {
      throw new Error(
        `Target '${target}' uses bayesian_update without a pre-test source (need additive pre-test edges or a third bayesian_update edge)`
      );
    }
  }
}

function validateNode(node: unknown): void {
  if (typeof node !== "object" || node === null) {
    throw new Error("Each node must be an object");
  }

  const n = node as Record<string, unknown>;

  if (typeof n.id !== "string" || n.id === "") {
    throw new Error("Node must have a non-empty 'id'");
  }
  if (typeof n.name !== "string") {
    throw new Error(`Node '${n.id}' must have a 'name' string`);
  }
  if (typeof n.description !== "string") {
    throw new Error(`Node '${n.id}' must have a 'description' string`);
  }
  if (!VALID_DISTRIBUTIONS.includes(n.distribution as string)) {
    throw new Error(
      `Node '${n.id}' has invalid distribution '${n.distribution}'. Must be one of: ${VALID_DISTRIBUTIONS.join(", ")}`
    );
  }
  if (typeof n.mean !== "number") {
    throw new Error(`Node '${n.id}' must have a numeric 'mean'`);
  }
  if (typeof n.sd !== "number" || n.sd <= 0) {
    throw new Error(`Node '${n.id}' must have a positive 'sd'`);
  }
  if (!Array.isArray(n.range) || n.range.length !== 2) {
    throw new Error(`Node '${n.id}' must have a 'range' array of [min, max]`);
  }
  if (typeof n.unit !== "string") {
    throw new Error(`Node '${n.id}' must have a 'unit' string`);
  }
}

/**
 * Normalize a raw node record into an UncertaintyNode with a populated `source`.
 *
 * - `source`: kept verbatim if it is exactly "literature" or "user_override".
 *   Anything else (missing, null, unknown string, or "llm_prior" itself)
 *   resolves to "llm_prior".
 * - `sourceNote`: preserved verbatim when present as a string; omitted otherwise.
 *
 * Runs after validateNode and validateGraphSemantics, so other fields are
 * already known to satisfy the schema.
 */
function normalizeNode(raw: Record<string, unknown>): UncertaintyNode {
  const rawSource = raw.source;
  const source: NodeSource =
    typeof rawSource === "string" &&
    (PRESERVED_SOURCES as readonly string[]).includes(rawSource)
      ? (rawSource as NodeSource)
      : "llm_prior";

  const normalized: UncertaintyNode = {
    id: raw.id as string,
    name: raw.name as string,
    description: raw.description as string,
    distribution: raw.distribution as UncertaintyNode["distribution"],
    mean: raw.mean as number,
    sd: raw.sd as number,
    range: [
      (raw.range as [number, number])[0],
      (raw.range as [number, number])[1],
    ],
    unit: raw.unit as string,
    source,
  };

  if (typeof raw.group === "string") {
    normalized.group = raw.group;
  }
  if (typeof raw.sourceNote === "string") {
    normalized.sourceNote = raw.sourceNote;
  }

  return normalized;
}

function validateEdge(edge: unknown): void {
  if (typeof edge !== "object" || edge === null) {
    throw new Error("Each edge must be an object");
  }

  const e = edge as Record<string, unknown>;

  if (typeof e.id !== "string" || e.id === "") {
    throw new Error("Edge must have a non-empty 'id'");
  }
  if (typeof e.source !== "string" || e.source === "") {
    throw new Error(`Edge '${e.id}' must have a non-empty 'source'`);
  }
  if (typeof e.target !== "string" || e.target === "") {
    throw new Error(`Edge '${e.id}' must have a non-empty 'target'`);
  }
  if (!VALID_METHODS.includes(e.method as CombinationMethod)) {
    throw new Error(
      `Edge '${e.id}' has invalid method '${e.method}'. Must be one of: ${VALID_METHODS.join(", ")}`
    );
  }
}
