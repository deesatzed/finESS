/**
 * Typed client for the Python ensemble sidecar (services/ensemble).
 *
 * The sidecar is a real FastAPI process that wraps the
 * `ace_hospital.UnifiedACEEnsemble` forecaster. This client does no
 * caching, no fallback to fake data, and no retry-on-empty heuristics
 * — if the sidecar is down, the caller should surface the error to the
 * user. R6-04 shipped train/predict; R6-05 consumed them from the
 * forecast route; R6-06 added recordOutcome + getPriors to close the
 * calibration loop.
 */

export interface EnsembleHealth {
  status: "ok" | "degraded";
  ensemble_version: string;
  chronos_enabled: boolean;
  chronos_size: string | null;
  models_available: string[];
  trained_columns: string[];
  import_error?: string | null;
}

export interface EnsembleTrainRequest {
  csvRows: Array<Record<string, unknown>>;
  dateColumn?: string;
  targetColumns: string[];
  trainFraction?: number;
  valFraction?: number;
  weightPriors?: Record<string, Record<string, { type: string; params: Record<string, number> }>>;
}

export interface EnsembleTrainResponse {
  trained_columns: string[];
  slsqp_weights: Record<string, Record<string, number>>;
  training_seconds: number;
  n_rows: number;
}

export interface EnsemblePredictRequest {
  csvRows: Array<Record<string, unknown>>;
  dateColumn?: string;
  targetColumn: string;
  nSteps?: number;
  useLatestPriors?: boolean;
}

export interface EnsemblePrediction {
  column: string;
  prediction: number;
  lower_95: number;
  upper_95: number;
  model_weights: Record<string, number>;
  individual_predictions: Record<string, number>;
  regime_type: string;
  rho: number;
  mode: string;
  /** R6-06: true if SLSQP weights were re-optimised against EMA priors. */
  priors_applied?: boolean;
  /** R6-06: number of /outcome calls accumulated for this column. */
  observation_count?: number;
}

export interface OutcomeRequest {
  column: string;
  modelPredictions: Record<string, number>;
  actual: number;
}

export interface BetaPrior {
  type: string;
  params: Record<string, number>;
}

export interface OutcomeResponse {
  column: string;
  updated_priors: Record<string, BetaPrior>;
  observation_count: number;
}

export interface PriorsResponse {
  column: string;
  priors: Record<string, BetaPrior>;
  observation_count: number;
  ema_mape: Record<string, number>;
}

export class EnsembleClientError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, detail: unknown) {
    super(
      typeof detail === "string"
        ? `ensemble sidecar ${status}: ${detail}`
        : `ensemble sidecar ${status}`,
    );
    this.name = "EnsembleClientError";
    this.status = status;
    this.detail = detail;
  }
}

export interface EnsembleClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class EnsembleClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EnsembleClientOptions = {}) {
    const envBase =
      typeof process !== "undefined" && process.env
        ? process.env.ENSEMBLE_SIDECAR_URL
        : undefined;
    this.baseUrl = (options.baseUrl ?? envBase ?? "http://localhost:8001").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async health(): Promise<EnsembleHealth> {
    return this.request<EnsembleHealth>("GET", "/health");
  }

  async train(req: EnsembleTrainRequest): Promise<EnsembleTrainResponse> {
    return this.request<EnsembleTrainResponse>("POST", "/train", {
      csv_rows: req.csvRows,
      date_column: req.dateColumn ?? "DayDate",
      target_columns: req.targetColumns,
      train_fraction: req.trainFraction ?? 0.6,
      val_fraction: req.valFraction ?? 0.2,
      weight_priors: req.weightPriors ?? null,
    });
  }

  async predict(req: EnsemblePredictRequest): Promise<EnsemblePrediction> {
    return this.request<EnsemblePrediction>("POST", "/predict", {
      csv_rows: req.csvRows,
      date_column: req.dateColumn ?? "DayDate",
      target_column: req.targetColumn,
      n_steps: req.nSteps ?? 1,
      use_latest_priors: req.useLatestPriors ?? true,
    });
  }

  /**
   * Record an observed (model_predictions, actual) pair for a column.
   *
   * The sidecar updates its EMA learner and returns the freshly-extracted
   * Beta priors. The next /predict on the same column with
   * useLatestPriors=true will re-optimise the SLSQP weights against these
   * priors. R6-06 only persists the outcome in SQLite — the sidecar's
   * in-process EMA is the calibration cache.
   */
  async recordOutcome(req: OutcomeRequest): Promise<OutcomeResponse> {
    return this.request<OutcomeResponse>("POST", "/outcome", {
      column: req.column,
      model_predictions: req.modelPredictions,
      actual: req.actual,
    });
  }

  /** Backwards-compatible alias retained for R6-04 callers. */
  async outcome(req: OutcomeRequest): Promise<OutcomeResponse> {
    return this.recordOutcome(req);
  }

  /**
   * Read the current EMA-derived Beta priors and per-model EMA MAPEs for a
   * column. Returns observation_count=0 with empty maps if the column has
   * never had an outcome recorded.
   */
  async getPriors(column: string): Promise<PriorsResponse> {
    return this.request<PriorsResponse>("GET", `/priors/${encodeURIComponent(column)}`);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? safeJsonParse(text) : undefined;
      if (!response.ok) {
        throw new EnsembleClientError(response.status, parsed ?? text);
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
