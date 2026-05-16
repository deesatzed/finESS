export interface RealDataAssistRequest {
  model: string;
  apiKey?: string;
  query: string;
  targetColumn: string;
  rowCount: number;
  missingCount: number;
  mean: number;
  median: number;
  ciLow: number;
  ciHigh: number;
  pAboveThreshold: number;
  threshold: number | null;
}

export interface RealDataInsight {
  summary: string;
  cautions: string[];
  nextChecks: string[];
}

export class RealDataAssistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealDataAssistError";
  }
}

const MAX_TEXT_LENGTH = 4_000;
const MAX_ITEMS = 5;

export function validateRealDataAssistRequest(
  value: unknown
): RealDataAssistRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RealDataAssistError("Real-data assist request must be an object");
  }
  const body = value as Record<string, unknown>;

  const model = requireString(body.model, "model");
  const query = requireString(body.query, "query");
  const targetColumn = requireString(body.targetColumn, "targetColumn");
  const rowCount = requireNonNegativeInteger(body.rowCount, "rowCount");
  const missingCount = requireNonNegativeInteger(body.missingCount, "missingCount");
  const mean = requireFiniteNumber(body.mean, "mean");
  const median = requireFiniteNumber(body.median, "median");
  const ciLow = requireFiniteNumber(body.ciLow, "ciLow");
  const ciHigh = requireFiniteNumber(body.ciHigh, "ciHigh");
  const pAboveThreshold = requireProbability(
    body.pAboveThreshold,
    "pAboveThreshold"
  );
  const threshold =
    body.threshold === null || body.threshold === undefined
      ? null
      : requireFiniteNumber(body.threshold, "threshold");
  const apiKey =
    typeof body.apiKey === "string" && body.apiKey.trim() !== ""
      ? body.apiKey.trim()
      : undefined;

  if (query.length > MAX_TEXT_LENGTH) throw new RealDataAssistError("query is too large");
  if (targetColumn.length > 256) {
    throw new RealDataAssistError("targetColumn is too large");
  }
  if (missingCount > rowCount) {
    throw new RealDataAssistError("missingCount cannot exceed rowCount");
  }

  return {
    model,
    apiKey,
    query,
    targetColumn,
    rowCount,
    missingCount,
    mean,
    median,
    ciLow,
    ciHigh,
    pAboveThreshold,
    threshold,
  };
}

export function buildRealDataAssistMessages(request: RealDataAssistRequest) {
  return [
    {
      role: "system",
      content:
        "You are finESS, a cautious empirical-analysis assistant. You never invent calculations, recommendations, thresholds, domain advice, or causal claims. Return strict JSON only with keys summary, cautions, nextChecks. Use the supplied observed-data statistics as authoritative.",
    },
    {
      role: "user",
      content: [
        "Interpret these observed-data statistics in plain language.",
        `Analysis label: ${request.query}`,
        `Target column: ${request.targetColumn}`,
        `Observed rows used: ${request.rowCount}`,
        `Missing target rows: ${request.missingCount}`,
        `Mean: ${request.mean}`,
        `Median: ${request.median}`,
        `Empirical 95% interval: [${request.ciLow}, ${request.ciHigh}]`,
        request.threshold === null
          ? "Threshold: none supplied"
          : `Threshold: ${request.threshold}; observed share above threshold: ${request.pAboveThreshold}`,
        "Do not give clinical, legal, financial, engineering, or policy advice.",
        "Use this JSON shape: {\"summary\":\"...\",\"cautions\":[\"...\"],\"nextChecks\":[\"...\"]}",
      ].join("\n"),
    },
  ];
}

export function parseRealDataInsight(content: string): RealDataInsight {
  const jsonText = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new RealDataAssistError("AI response was not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RealDataAssistError("AI response JSON must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const summary = requireString(record.summary, "summary");
  const cautions = requireStringArray(record.cautions, "cautions");
  const nextChecks = requireStringArray(record.nextChecks, "nextChecks");

  return {
    summary: summary.slice(0, MAX_TEXT_LENGTH),
    cautions: cautions.slice(0, MAX_ITEMS),
    nextChecks: nextChecks.slice(0, MAX_ITEMS),
  };
}

function extractJsonObject(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RealDataAssistError(`${label} is required`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new RealDataAssistError(`${label} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new RealDataAssistError(`${label}[${index}] must be a string`);
    }
    return item.trim().slice(0, 1_000);
  });
}

function requireFiniteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RealDataAssistError(`${label} must be a finite number`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    !Number.isFinite(value)
  ) {
    throw new RealDataAssistError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireProbability(value: unknown, label: string) {
  const numeric = requireFiniteNumber(value, label);
  if (numeric < 0 || numeric > 1) {
    throw new RealDataAssistError(`${label} must be between 0 and 1`);
  }
  return numeric;
}
