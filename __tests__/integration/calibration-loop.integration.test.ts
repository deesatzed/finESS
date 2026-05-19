/**
 * Live integration test for the R6-06 calibration loop.
 *
 * Boots-or-assumes the Python ensemble sidecar (services/ensemble) at
 * ENSEMBLE_SIDECAR_URL and exercises the closed loop:
 *
 *   POST /api/forecast              -> baseline weights (and resets ace_deltas
 *                                       for the column as a side effect of
 *                                       /train; see services/ensemble/app.py)
 *   POST /api/calibration (x N)     -> outcomes biased toward one model
 *   POST /api/forecast (again)      -> weights re-applied with new deltas
 *
 * The assertion that proves the loop is real: the favoured model's
 * weight rises by at least MIN_WEIGHT_SHIFT after N outcomes.
 *
 * SKIPPED by default. To run:
 *
 *   docker compose up -d ensemble
 *   curl -fsS http://localhost:8001/health
 *   RUN_ENSEMBLE_INTEGRATION=1 npx jest \
 *     __tests__/integration/calibration-loop.integration.test.ts --runInBand
 *   docker compose down
 *
 * Per project rules: the actuals fed via /api/calibration are NOT mock
 * product data. They are part of a controlled test scenario built on top
 * of REAL ensemble predictions captured from the live sidecar — this is
 * how we engineer a measurable weight shift without polluting production
 * defaults. The sidecar's EMA observation counter is process-scoped and
 * is NOT reset between test runs; the test reads the starting count and
 * asserts relative-to-start deltas rather than absolute counts so it
 * stays stable across repeated runs against the same long-lived sidecar.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import type { LocalAuthSession } from "@/lib/auth/local-session";

const RUN = process.env.RUN_ENSEMBLE_INTEGRATION === "1";
const SIDECAR_BASE =
  process.env.ENSEMBLE_SIDECAR_URL ?? "http://localhost:8001";
const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "services",
  "ensemble",
  "fixtures",
  "hospital-census-sample.csv",
);
const TEST_DATABASE_URL = "file:./calibration-loop.test.db";

const N_OUTCOMES = 6;
const MIN_WEIGHT_SHIFT = 0.005;

interface ForecastApiResponse {
  forecast: {
    column: string;
    prediction: number;
    lower_95: number;
    upper_95: number;
    model_weights: Record<string, number>;
    individual_predictions: Record<string, number>;
    regime_type: string;
    rho: number;
    mode: string;
    priors_applied?: boolean;
    observation_count?: number;
  };
  forecastId: string;
  slsqpWeights: Record<string, number>;
  trainedAt: string;
  rowCount: number;
}

(RUN ? describe : describe.skip)("R6-06 calibration loop (live ensemble)", () => {
  let forecastRoute: typeof import("@/app/api/forecast/route");
  let calibrationRoute: typeof import("@/app/api/calibration/route");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let prisma: import("@prisma/client").PrismaClient;
  let owner: LocalAuthSession;
  let csvText: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ENSEMBLE_SIDECAR_URL = SIDECAR_BASE;
    const pushed = spawnSync(
      "npx",
      ["prisma", "db", "push", "--skip-generate"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        encoding: "utf8",
      },
    );
    if (pushed.status !== 0) {
      throw new Error(pushed.stderr || pushed.stdout);
    }
    forecastRoute = await import("@/app/api/forecast/route");
    calibrationRoute = await import("@/app/api/calibration/route");
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));
    ({ prisma } = await import("@/lib/db"));
    owner = await createLocalAuthSession("owner-calibration-loop");

    csvText = fs.readFileSync(FIXTURE, "utf8");

    // Confirm sidecar is reachable; if not, fail loudly rather than
    // hang on the first /api/forecast call.
    const health = await fetch(`${SIDECAR_BASE}/health`).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(
        `Ensemble sidecar not reachable at ${SIDECAR_BASE}/health. ` +
          `Start it with 'docker compose up -d ensemble' before running ` +
          `this test.`,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.calibrationOutcome.deleteMany();
  });

  async function callForecast(): Promise<ForecastApiResponse> {
    const request = new NextRequest("http://localhost/api/forecast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `finess_local_session=${owner.token}`,
      },
      body: JSON.stringify({
        csv: csvText,
        dateColumn: "DayDate",
        targetColumn: "Total_Census",
        horizon: 1,
      }),
    });
    const response = await forecastRoute.POST(request);
    if (response.status !== 200) {
      const text = await response.text();
      throw new Error(`/api/forecast failed: ${response.status} ${text}`);
    }
    return (await response.json()) as ForecastApiResponse;
  }

  async function callCalibration(
    forecastId: string,
    modelPredictions: Record<string, number>,
    actualValue: number,
    ensemblePrediction: number,
  ): Promise<{ id: string; sidecarStatus: string; observationCount?: number }> {
    const request = new NextRequest("http://localhost/api/calibration", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `finess_local_session=${owner.token}`,
      },
      body: JSON.stringify({
        forecastId,
        predictedProbability: 0.5,
        actualOutcome:
          Math.abs(actualValue - ensemblePrediction) <=
          Math.max(Math.abs(ensemblePrediction) * 0.1, 0.5),
        targetColumn: "Total_Census",
        modelPredictions,
        actualValue,
      }),
    });
    const response = await calibrationRoute.POST(request);
    const body = (await response.json()) as {
      id: string;
      sidecarStatus: string;
      observationCount?: number;
    };
    if (response.status !== 201) {
      throw new Error(
        `/api/calibration failed: ${response.status} ${JSON.stringify(body)}`,
      );
    }
    return body;
  }

  it("shifts ensemble weights toward the favoured model after N outcomes", async () => {
    // Baseline forecast — captures real per-model predictions on the
    // fixture and the initial SLSQP weights. /train zeroes ace_deltas for
    // the column as a side effect so the baseline weights are the pure
    // SLSQP-optimised values, regardless of any earlier test runs.
    const baseline = await callForecast();
    const baselineWeights = baseline.forecast.model_weights;
    const preds = baseline.forecast.individual_predictions;
    const modelNames = Object.keys(preds);
    expect(modelNames.length).toBeGreaterThanOrEqual(3);

    // The sidecar's EMA observation counter is process-scoped and never
    // reset by /train. Capture its current value so we can assert N more
    // outcomes are added rather than the absolute count.
    const startingObservationCount =
      baseline.forecast.observation_count ?? 0;

    // Pick the lowest-weighted model so a shift is easy to detect even
    // if the baseline already prefers a different model.
    const favoured = modelNames.reduce((acc, name) =>
      baselineWeights[name] < baselineWeights[acc] ? name : acc,
    modelNames[0]);
    const favouredPred = preds[favoured];

    // Feed N outcomes whose actual == favoured model's prediction.
    // That model's MAPE is exactly 0 on each outcome; the others get
    // strictly positive MAPE driven by their honest disagreement.
    let lastObservation = startingObservationCount;
    for (let i = 0; i < N_OUTCOMES; i++) {
      const body = await callCalibration(
        baseline.forecastId,
        preds,
        favouredPred,
        baseline.forecast.prediction,
      );
      expect(body.sidecarStatus).toBe("updated");
      expect(body.observationCount).toBe(startingObservationCount + i + 1);
      lastObservation = body.observationCount ?? lastObservation;
    }
    expect(lastObservation).toBe(startingObservationCount + N_OUTCOMES);

    // Second forecast — should apply the EMA-derived ace_deltas and report
    // priors_applied=true. observation_count is informational and equals
    // the running total on the sidecar.
    const after = await callForecast();
    expect(after.forecast.priors_applied).toBe(true);
    expect(after.forecast.observation_count).toBe(lastObservation);

    const afterWeights = after.forecast.model_weights;
    const shift = afterWeights[favoured] - baselineWeights[favoured];
    expect(shift).toBeGreaterThanOrEqual(MIN_WEIGHT_SHIFT);

    // The total weight still sums to ~1.
    const total = Object.values(afterWeights).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0.99);
    expect(total).toBeLessThan(1.01);

    // The /api/calibration handler audited every outcome.
    const audits = await prisma.auditEvent.findMany({
      where: { eventType: "forecast_outcome_recorded" },
    });
    expect(audits.length).toBe(N_OUTCOMES);
  }, 600_000);
});
