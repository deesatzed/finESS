/**
 * Semantic Mode B5a — Forecast-as-research unit tests.
 *
 * The injected `EnsembleClient` instances in these tests are TEST HARNESSES
 * used only to observe `researchForecast` behavior in isolation (parsing,
 * error mapping, bundle construction). They are NOT product mocks — no
 * product code path consumes them. The real-network proof is the gated
 * `__tests__/integration/semantic-research-forecast.integration.test.ts`.
 */

import {
  ForecastResearchError,
  researchForecast,
  type ForecastResearchOptions,
} from "@/lib/semantic/research/forecast";
import {
  EnsembleClient,
  EnsembleClientError,
  type EnsemblePrediction,
  type EnsembleTrainResponse,
} from "@/lib/services/ensemble-client";
import type { ProposedComponent } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<ProposedComponent> = {},
): ProposedComponent {
  return {
    id: "next_quarter_census",
    name: "Next Quarter Census",
    description: "Predicted hospital census for the next quarter.",
    suggestedDistribution: "normal",
    ...overrides,
  };
}

function makeCsvRows(n = 10): Array<Record<string, string | number>> {
  // Tiny REAL fixture. Not product mock — the rows are passed verbatim
  // to the injected EnsembleClient stub, which never makes a network
  // call. Production callers pass actual operator data; this fixture is
  // only here so the adapter can be exercised without a sidecar.
  const rows: Array<Record<string, string | number>> = [];
  for (let i = 0; i < n; i++) {
    rows.push({ DayDate: `2026-01-${String(i + 1).padStart(2, "0")}`, Census: 100 + i });
  }
  return rows;
}

function happyPrediction(
  overrides: Partial<EnsemblePrediction> = {},
): EnsemblePrediction {
  return {
    column: "Census",
    prediction: 120,
    lower_95: 100,
    upper_95: 140,
    model_weights: { arima: 0.4, prophet: 0.35, chronos: 0.25 },
    individual_predictions: { arima: 118, prophet: 121, chronos: 124 },
    regime_type: "stable",
    rho: 0.92,
    mode: "ensemble",
    ...overrides,
  };
}

interface FakeClientOptions {
  train?: EnsembleTrainResponse | Error;
  predict?: EnsemblePrediction | Error;
}

function fakeClient(opts: FakeClientOptions = {}): EnsembleClient {
  // Construct a real EnsembleClient and override its train/predict
  // methods. We do not invoke the constructor's network paths because
  // we never call the resulting client's `request`.
  const client = new EnsembleClient({ baseUrl: "http://test-no-network" });
  const trainResult: EnsembleTrainResponse = opts.train instanceof Error
    ? // unused; the override below throws first
      ({ trained_columns: [], slsqp_weights: {}, training_seconds: 0, n_rows: 0 } as EnsembleTrainResponse)
    : (opts.train ?? {
        trained_columns: ["Census"],
        slsqp_weights: { Census: { arima: 0.4, prophet: 0.35, chronos: 0.25 } },
        training_seconds: 0.1,
        n_rows: 10,
      });

  (client as unknown as { train: () => Promise<EnsembleTrainResponse> }).train = jest
    .fn()
    .mockImplementation(() => {
      if (opts.train instanceof Error) return Promise.reject(opts.train);
      return Promise.resolve(trainResult);
    });

  (client as unknown as { predict: () => Promise<EnsemblePrediction> }).predict = jest
    .fn()
    .mockImplementation(() => {
      if (opts.predict instanceof Error) return Promise.reject(opts.predict);
      return Promise.resolve(opts.predict ?? happyPrediction());
    });

  return client;
}

function baseOptions(
  overrides: Partial<ForecastResearchOptions> = {},
): ForecastResearchOptions {
  return {
    component: makeComponent(),
    csvRows: makeCsvRows(),
    dateColumn: "DayDate",
    targetColumn: "Census",
    horizon: 1,
    ensembleClient: fakeClient(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("researchForecast — happy path", () => {
  test("returns an ensemble_forecast bundle with mean = prediction, sd = ci-width/3.92", async () => {
    const result = await researchForecast(baseOptions());

    expect(result.bundle.mechanism).toBe("ensemble_forecast");
    expect(result.bundle.proposedDistribution).toBe("normal");
    expect(result.bundle.proposedParams.mean).toBe(120);
    // (140 - 100) / 3.92
    expect(result.bundle.proposedParams.sd).toBeCloseTo(40 / 3.92, 6);
    expect(result.perModelWeights).toEqual({
      arima: 0.4,
      prophet: 0.35,
      chronos: 0.25,
    });
    expect(result.individualPredictions).toEqual({
      arima: 118,
      prophet: 121,
      chronos: 124,
    });
    expect(result.ensembleLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("bundle.componentId is forced to component.id (not the sidecar column)", async () => {
    const result = await researchForecast(
      baseOptions({
        component: makeComponent({ id: "operator_named_factor" }),
      }),
    );
    expect(result.bundle.componentId).toBe("operator_named_factor");
    // The sidecar's column field ("Census") never leaks into componentId.
    expect(result.bundle.componentId).not.toBe("Census");
  });

  test("emits one citation per ensemble model with weight + individual prediction", async () => {
    const result = await researchForecast(baseOptions());
    expect(result.bundle.citations).toHaveLength(3);
    const sources = result.bundle.citations.map((c) => c.source);
    expect(sources).toEqual(
      expect.arrayContaining([
        "ensemble-model:arima",
        "ensemble-model:prophet",
        "ensemble-model:chronos",
      ]),
    );
    const arimaCitation = result.bundle.citations.find(
      (c) => c.source === "ensemble-model:arima",
    );
    expect(arimaCitation?.snippet).toBe("weight=0.400 prediction=118.00");
  });

  test("reasoning string names per-model weights and the regime", async () => {
    const result = await researchForecast(
      baseOptions({
        ensembleClient: fakeClient({
          predict: happyPrediction({ regime_type: "volatile" }),
        }),
      }),
    );
    expect(result.bundle.reasoning).toMatch(/Ensemble forecast over 10 rows/);
    expect(result.bundle.reasoning).toMatch(/arima=0\.400/);
    expect(result.bundle.reasoning).toMatch(/Regime: volatile/);
  });
});

describe("researchForecast — input validation", () => {
  test("empty csvRows -> EMPTY_CSV", async () => {
    await expect(
      researchForecast(baseOptions({ csvRows: [] })),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "EMPTY_CSV",
    });
  });

  test("invalid horizon -> INVALID_HORIZON", async () => {
    await expect(
      researchForecast(
        baseOptions({
          // Cast to bypass compile-time guard; the runtime check is what we
          // are validating.
          horizon: 7 as unknown as 1,
        }),
      ),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "INVALID_HORIZON",
    });
  });

  test("missing component id -> EMPTY_CSV (input-shape failure)", async () => {
    await expect(
      researchForecast(
        baseOptions({
          component: makeComponent({ id: "   " }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "EMPTY_CSV",
    });
  });
});

describe("researchForecast — sidecar error mapping", () => {
  test("EnsembleClientError -> SIDECAR_ERROR", async () => {
    const client = fakeClient({
      predict: new EnsembleClientError(500, "internal sidecar boom"),
    });
    await expect(
      researchForecast(baseOptions({ ensembleClient: client })),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "SIDECAR_ERROR",
    });
  });

  test("network error -> SIDECAR_UNREACHABLE", async () => {
    const client = fakeClient({
      predict: new Error("ECONNREFUSED 127.0.0.1:8001"),
    });
    await expect(
      researchForecast(baseOptions({ ensembleClient: client })),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "SIDECAR_UNREACHABLE",
    });
  });

  test("train-time EnsembleClientError -> SIDECAR_ERROR (not unreachable)", async () => {
    const client = fakeClient({
      train: new EnsembleClientError(422, "training rejected"),
    });
    await expect(
      researchForecast(baseOptions({ ensembleClient: client })),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "SIDECAR_ERROR",
    });
  });
});

describe("researchForecast — degenerate CI honesty", () => {
  test("ci_high === ci_low -> DEGENERATE_CI (refuses to fabricate spread)", async () => {
    const client = fakeClient({
      predict: happyPrediction({ lower_95: 100, upper_95: 100, prediction: 100 }),
    });
    await expect(
      researchForecast(baseOptions({ ensembleClient: client })),
    ).rejects.toMatchObject({
      name: "ForecastResearchError",
      code: "DEGENERATE_CI",
    });
  });
});

describe("ForecastResearchError", () => {
  test("carries the code field for callers to switch on", () => {
    const err = new ForecastResearchError("boom", "SIDECAR_UNREACHABLE");
    expect(err.name).toBe("ForecastResearchError");
    expect(err.code).toBe("SIDECAR_UNREACHABLE");
    expect(err instanceof Error).toBe(true);
  });
});
