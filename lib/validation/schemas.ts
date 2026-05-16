import type {
  CombinationMethod,
  DistributionType,
  ReasoningEdge,
  SensitivityResult,
  SimulationResult,
  UncertaintyGraph,
  UncertaintyNode,
} from "@/lib/types";

const VALID_DISTRIBUTIONS: DistributionType[] = [
  "beta",
  "normal",
  "uniform",
  "lognormal",
];

const VALID_METHODS: CombinationMethod[] = [
  "additive",
  "subtractive",
  "bayesian_update",
  "multiplicative",
];

const MAX_QUERY_LENGTH = 20_000;
const MAX_JSON_BYTES = 1_000_000;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface AnalysisSaveRequest {
  query: string;
  graph: UncertaintyGraph;
  result: SimulationResult | null;
  sensitivity: SensitivityResult[] | null;
  seed: number | null;
}

export interface CalibrationOutcomeRequest {
  analysisId: string;
  predictedProbability: number;
  actualOutcome: boolean;
}

export interface AnalyzeRequest {
  query: string;
  model: string;
  apiKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value;
}

function validateNode(value: unknown): UncertaintyNode {
  const node = requireRecord(value, "Node");

  if (typeof node.id !== "string" || node.id.trim() === "") {
    throw new ValidationError("Node must have a non-empty id");
  }
  if (typeof node.name !== "string") {
    throw new ValidationError(`Node '${node.id}' must have a name string`);
  }
  if (typeof node.description !== "string") {
    throw new ValidationError(`Node '${node.id}' must have a description string`);
  }
  if (!VALID_DISTRIBUTIONS.includes(node.distribution as DistributionType)) {
    throw new ValidationError(
      `Node '${node.id}' has invalid distribution '${String(node.distribution)}'`
    );
  }
  if (typeof node.mean !== "number" || !Number.isFinite(node.mean)) {
    throw new ValidationError(`Node '${node.id}' must have a finite mean`);
  }
  if (typeof node.sd !== "number" || !Number.isFinite(node.sd) || node.sd <= 0) {
    throw new ValidationError(`Node '${node.id}' must have a positive sd`);
  }
  if (
    !Array.isArray(node.range) ||
    node.range.length !== 2 ||
    typeof node.range[0] !== "number" ||
    typeof node.range[1] !== "number"
  ) {
    throw new ValidationError(`Node '${node.id}' must have range [min, max]`);
  }
  if (typeof node.unit !== "string") {
    throw new ValidationError(`Node '${node.id}' must have a unit string`);
  }

  return {
    id: node.id,
    name: node.name,
    description: node.description,
    distribution: node.distribution as DistributionType,
    mean: node.mean,
    sd: node.sd,
    range: [node.range[0], node.range[1]],
    unit: node.unit,
    group: typeof node.group === "string" ? node.group : undefined,
  };
}

function validateEdge(value: unknown): ReasoningEdge {
  const edge = requireRecord(value, "Edge");

  if (typeof edge.id !== "string" || edge.id.trim() === "") {
    throw new ValidationError("Edge must have a non-empty id");
  }
  if (typeof edge.source !== "string" || edge.source.trim() === "") {
    throw new ValidationError(`Edge '${edge.id}' must have a non-empty source`);
  }
  if (typeof edge.target !== "string" || edge.target.trim() === "") {
    throw new ValidationError(`Edge '${edge.id}' must have a non-empty target`);
  }
  if (!VALID_METHODS.includes(edge.method as CombinationMethod)) {
    throw new ValidationError(
      `Edge '${edge.id}' has invalid method '${String(edge.method)}'`
    );
  }

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    method: edge.method as CombinationMethod,
    label: typeof edge.label === "string" ? edge.label : undefined,
  };
}

export function validateUncertaintyGraph(value: unknown): UncertaintyGraph {
  const graph = requireRecord(value, "Graph");

  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new ValidationError("Graph must contain a non-empty nodes array");
  }
  if (!Array.isArray(graph.edges) || graph.edges.length === 0) {
    throw new ValidationError("Graph must contain a non-empty edges array");
  }
  if (typeof graph.outputNodeId !== "string" || graph.outputNodeId.trim() === "") {
    throw new ValidationError("Graph must have a non-empty outputNodeId");
  }
  if (jsonSize(graph) > MAX_JSON_BYTES) {
    throw new ValidationError("graph payload is too large");
  }

  return {
    nodes: graph.nodes.map(validateNode),
    edges: graph.edges.map(validateEdge),
    outputNodeId: graph.outputNodeId,
    analysisMode:
      graph.analysisMode === "observed" || graph.analysisMode === "simulation"
        ? graph.analysisMode
        : undefined,
    threshold: typeof graph.threshold === "number" ? graph.threshold : undefined,
    narration: typeof graph.narration === "string" ? graph.narration : undefined,
  };
}

export function validateAnalysisSaveRequest(value: unknown): AnalysisSaveRequest {
  const body = requireRecord(value, "Analysis save request");

  if (typeof body.query !== "string" || body.query.trim() === "") {
    throw new ValidationError("query is required");
  }
  if (body.query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError("query is too large");
  }

  const graph = validateUncertaintyGraph(body.graph);
  const result =
    body.result === undefined || body.result === null
      ? null
      : (requireRecord(body.result, "result") as unknown as SimulationResult);
  const sensitivity =
    body.sensitivity === undefined || body.sensitivity === null
      ? null
      : Array.isArray(body.sensitivity)
        ? (body.sensitivity as SensitivityResult[])
        : (() => {
            throw new ValidationError("sensitivity must be an array");
          })();

  if (jsonSize({ graph, result, sensitivity }) > MAX_JSON_BYTES) {
    throw new ValidationError("analysis payload is too large");
  }

  if (
    body.seed !== undefined &&
    body.seed !== null &&
    (!Number.isInteger(body.seed) || !Number.isFinite(body.seed))
  ) {
    throw new ValidationError("seed must be an integer");
  }

  return {
    query: body.query,
    graph,
    result,
    sensitivity,
    seed: typeof body.seed === "number" ? body.seed : null,
  };
}

export function validateCalibrationOutcomeRequest(
  value: unknown
): CalibrationOutcomeRequest {
  const body = requireRecord(value, "Calibration outcome request");

  if (typeof body.analysisId !== "string" || body.analysisId.trim() === "") {
    throw new ValidationError("analysisId is required");
  }
  if (
    typeof body.predictedProbability !== "number" ||
    !Number.isFinite(body.predictedProbability) ||
    body.predictedProbability < 0 ||
    body.predictedProbability > 1
  ) {
    throw new ValidationError("predictedProbability must be a number between 0 and 1");
  }
  if (typeof body.actualOutcome !== "boolean") {
    throw new ValidationError("actualOutcome must be boolean");
  }

  return {
    analysisId: body.analysisId,
    predictedProbability: body.predictedProbability,
    actualOutcome: body.actualOutcome,
  };
}

export function validateAnalyzeRequest(value: unknown): AnalyzeRequest {
  const body = requireRecord(value, "Analyze request");

  if (typeof body.query !== "string" || body.query.trim() === "") {
    throw new ValidationError("query is required");
  }
  if (body.query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError("query is too large");
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new ValidationError("model is required");
  }

  return {
    query: body.query,
    model: body.model,
    apiKey:
      typeof body.apiKey === "string" && body.apiKey.trim() !== ""
        ? body.apiKey.trim()
        : undefined,
  };
}
