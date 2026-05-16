import type { UncertaintyGraph, CombinationMethod } from "@/lib/types";

const VALID_METHODS: CombinationMethod[] = [
  "additive",
  "subtractive",
  "bayesian_update",
  "multiplicative",
];

const VALID_DISTRIBUTIONS = ["beta", "normal", "uniform", "lognormal"];

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

  return {
    nodes: obj.nodes as UncertaintyGraph["nodes"],
    edges: obj.edges as UncertaintyGraph["edges"],
    outputNodeId: obj.outputNodeId as string,
    threshold: typeof obj.threshold === "number" ? obj.threshold : undefined,
    narration: typeof obj.narration === "string" ? obj.narration : undefined,
  };
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
