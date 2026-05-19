import type {
  CombinationMethod,
  DistributionType,
  ReasoningEdge,
  SensitivityResult,
  SimulationResult,
  UncertaintyGraph,
  UncertaintyNode,
} from "@/lib/types";
import type { ForecastHorizon, ForecastRequest } from "@/lib/forecast/types";

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
const MAX_CSV_BYTES = 5_000_000;
const MAX_MULTI_MODELS = 8;
const VALID_HORIZONS: ForecastHorizon[] = [1, 2, 3];

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

/**
 * Calibration outcome payload (R6-06).
 *
 * Two shapes:
 *
 *  * Analysis branch — caller supplies `analysisId`. Used by Path A graphs.
 *  * Forecast branch — caller supplies `forecastId` AND the trio
 *    (`targetColumn`, `modelPredictions`, `actualValue`). The route handler
 *    forwards the trio to the ensemble sidecar's `/outcome` endpoint so
 *    the next forecast on the same column re-optimises weights against
 *    the EMA-derived priors. Persisting `predictedProbability` /
 *    `actualOutcome` to SQLite still works (and is required for the
 *    calibration curve UI) by mapping "actualValue == predicted within
 *    tolerance" -> boolean — but the actual numeric value is the
 *    load-bearing field for the loop.
 *
 * The handler enforces exactly-one-id; the validator only checks shape.
 */
export interface CalibrationOutcomeRequest {
  analysisId?: string;
  forecastId?: string;
  predictedProbability: number;
  actualOutcome: boolean;
  /** R6-06 forecast feedback: column the forecast targeted. */
  targetColumn?: string;
  /** R6-06 forecast feedback: per-base-model predictions returned by /api/forecast. */
  modelPredictions?: Record<string, number>;
  /** R6-06 forecast feedback: the real numeric outcome value. */
  actualValue?: number;
}

export interface AnalyzeRequest {
  query: string;
  model: string;
  apiKey?: string;
}

/**
 * R6-02 — Request payload for `/api/analyze/multi`.
 *
 * Unlike single-model analyze, `model` is not required: an empty/omitted
 * `models` array means "use whatever the server has configured in
 * OPENROUTER_MODELS". When the caller does pass models, the array is the
 * source of truth — we never silently inject extras.
 */
export interface MultiAnalyzeRequest {
  query: string;
  models?: string[];
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

  const validated: UncertaintyNode = {
    id: node.id,
    name: node.name,
    description: node.description,
    distribution: node.distribution as DistributionType,
    mean: node.mean,
    sd: node.sd,
    range: [node.range[0], node.range[1]],
    unit: node.unit,
    group: typeof node.group === "string" ? node.group : undefined,
    // M8-08: carry provenance through save/load. Mirror the coercion in
    // lib/ai/parse-response.ts:normalizeNode so missing/unknown values resolve
    // to "llm_prior" rather than dropping the field. Without this, user edits
    // that set source = "user_override" silently revert on next load.
    source:
      node.source === "literature" || node.source === "user_override"
        ? node.source
        : "llm_prior",
  };
  if (typeof node.sourceNote === "string" && node.sourceNote.trim() !== "") {
    validated.sourceNote = node.sourceNote;
  }
  return validated;
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

  const analysisId =
    typeof body.analysisId === "string" && body.analysisId.trim() !== ""
      ? body.analysisId.trim()
      : undefined;
  const forecastId =
    typeof body.forecastId === "string" && body.forecastId.trim() !== ""
      ? body.forecastId.trim()
      : undefined;

  if (!analysisId && !forecastId) {
    throw new ValidationError("analysisId or forecastId is required");
  }
  if (analysisId && forecastId) {
    throw new ValidationError(
      "exactly one of analysisId or forecastId may be provided"
    );
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

  // R6-06 — forecast-mode feedback fields. All optional, but if any one
  // of (targetColumn, modelPredictions, actualValue) is provided, the
  // other two are required (otherwise the sidecar cannot record the
  // outcome). The route handler is the one that actually decides whether
  // to forward to the sidecar, but the schema rejects half-built payloads
  // up front so we don't end up persisting calibration rows that quietly
  // never reach the EMA learner.
  let targetColumn: string | undefined;
  let modelPredictions: Record<string, number> | undefined;
  let actualValue: number | undefined;

  const hasAnyFeedbackField =
    body.targetColumn !== undefined ||
    body.modelPredictions !== undefined ||
    body.actualValue !== undefined;

  if (hasAnyFeedbackField) {
    if (typeof body.targetColumn !== "string" || body.targetColumn.trim() === "") {
      throw new ValidationError(
        "targetColumn is required when forecast feedback fields are present"
      );
    }
    targetColumn = body.targetColumn.trim();

    if (!isRecord(body.modelPredictions)) {
      throw new ValidationError(
        "modelPredictions must be an object of {model: number} when forecast feedback is present"
      );
    }
    const cleaned: Record<string, number> = {};
    for (const [model, pred] of Object.entries(body.modelPredictions)) {
      if (typeof model !== "string" || model.trim() === "") {
        throw new ValidationError("modelPredictions keys must be non-empty strings");
      }
      if (typeof pred !== "number" || !Number.isFinite(pred)) {
        throw new ValidationError(
          `modelPredictions['${model}'] must be a finite number`
        );
      }
      cleaned[model.trim()] = pred;
    }
    if (Object.keys(cleaned).length === 0) {
      throw new ValidationError("modelPredictions must contain at least one entry");
    }
    modelPredictions = cleaned;

    if (typeof body.actualValue !== "number" || !Number.isFinite(body.actualValue)) {
      throw new ValidationError("actualValue must be a finite number");
    }
    actualValue = body.actualValue;
  }

  return {
    analysisId,
    forecastId,
    predictedProbability: body.predictedProbability,
    actualOutcome: body.actualOutcome,
    targetColumn,
    modelPredictions,
    actualValue,
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

export function validateMultiAnalyzeRequest(value: unknown): MultiAnalyzeRequest {
  const body = requireRecord(value, "Multi-analyze request");

  if (typeof body.query !== "string" || body.query.trim() === "") {
    throw new ValidationError("query is required");
  }
  if (body.query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError("query is too large");
  }

  let models: string[] | undefined;
  if (body.models !== undefined && body.models !== null) {
    if (!Array.isArray(body.models)) {
      throw new ValidationError("models must be an array of strings");
    }
    const cleaned: string[] = [];
    for (const entry of body.models) {
      if (typeof entry !== "string") {
        throw new ValidationError("models must contain only strings");
      }
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      cleaned.push(trimmed);
    }
    if (cleaned.length > MAX_MULTI_MODELS) {
      throw new ValidationError(
        `models may not exceed ${MAX_MULTI_MODELS} entries`
      );
    }
    models = cleaned.length > 0 ? cleaned : undefined;
  }

  return {
    query: body.query,
    models,
    apiKey:
      typeof body.apiKey === "string" && body.apiKey.trim() !== ""
        ? body.apiKey.trim()
        : undefined,
  };
}

export function validateForecastRequest(value: unknown): ForecastRequest {
  const body = requireRecord(value, "Forecast request");

  if (typeof body.csv !== "string" || body.csv.trim() === "") {
    throw new ValidationError("csv is required");
  }
  if (Buffer.byteLength(body.csv, "utf8") > MAX_CSV_BYTES) {
    throw new ValidationError("csv payload is too large");
  }
  if (typeof body.dateColumn !== "string" || body.dateColumn.trim() === "") {
    throw new ValidationError("dateColumn is required");
  }
  if (typeof body.targetColumn !== "string" || body.targetColumn.trim() === "") {
    throw new ValidationError("targetColumn is required");
  }
  const horizon = body.horizon;
  if (
    typeof horizon !== "number" ||
    !Number.isInteger(horizon) ||
    !VALID_HORIZONS.includes(horizon as ForecastHorizon)
  ) {
    throw new ValidationError("horizon must be 1, 2, or 3");
  }

  return {
    csv: body.csv,
    dateColumn: body.dateColumn.trim(),
    targetColumn: body.targetColumn.trim(),
    horizon: horizon as ForecastHorizon,
  };
}
