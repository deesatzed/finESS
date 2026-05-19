/**
 * Live integration test for POST /api/forecast (R6-05).
 *
 * Boots-or-assumes the Python ensemble sidecar (services/ensemble) at
 * ENSEMBLE_SIDECAR_URL and trains + predicts using the real fixture at
 * services/ensemble/fixtures/hospital-census-sample.csv.
 *
 * SKIPPED by default. To run:
 *
 *   docker compose up -d ensemble
 *   curl -fsS http://localhost:8001/health
 *   RUN_ENSEMBLE_INTEGRATION=1 npx jest \
 *     __tests__/integration/forecast.integration.test.ts --runInBand
 *   docker compose down
 *
 * Assertions check SHAPE, not specific numeric values — the underlying
 * ensemble weights/predictions can shift across versions and we do not
 * want to lock the test to a release of ace_hospital.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";

const RUN = process.env.RUN_ENSEMBLE_INTEGRATION === "1";
const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "services",
  "ensemble",
  "fixtures",
  "hospital-census-sample.csv",
);
const TEST_DATABASE_URL = "file:./forecast-integration.test.db";

(RUN ? describe : describe.skip)("POST /api/forecast (live ensemble)", () => {
  let POST: typeof import("@/app/api/forecast/route").POST;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
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
    ({ POST } = await import("@/app/api/forecast/route"));
  }, 60_000);

  it("returns a real ensemble forecast for the hospital census fixture", async () => {
    const csv = fs.readFileSync(FIXTURE, "utf8");
    const request = new NextRequest("http://localhost/api/forecast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csv,
        dateColumn: "DayDate",
        targetColumn: "Total_Census",
        horizon: 1,
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
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
      };
      forecastId: string;
      slsqpWeights: Record<string, number>;
      trainedAt: string;
      rowCount: number;
    };

    expect(data.forecast.column).toBe("Total_Census");
    expect(Number.isFinite(data.forecast.prediction)).toBe(true);
    expect(data.forecast.lower_95).toBeLessThanOrEqual(data.forecast.prediction);
    expect(data.forecast.upper_95).toBeGreaterThanOrEqual(data.forecast.prediction);

    const weights = Object.values(data.forecast.model_weights);
    expect(weights.length).toBeGreaterThanOrEqual(3);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    expect(weightSum).toBeGreaterThan(0.99);
    expect(weightSum).toBeLessThan(1.01);

    expect(
      Object.keys(data.forecast.individual_predictions).length,
    ).toBeGreaterThanOrEqual(3);
    expect(typeof data.forecast.regime_type).toBe("string");
    expect(data.forecast.regime_type.length).toBeGreaterThan(0);

    expect(typeof data.forecastId).toBe("string");
    expect(data.forecastId.length).toBeGreaterThanOrEqual(16);
    expect(typeof data.trainedAt).toBe("string");
    expect(data.rowCount).toBeGreaterThan(100);
    expect(Object.keys(data.slsqpWeights).length).toBeGreaterThanOrEqual(3);
  }, 180_000);
});
