/**
 * Live integration test for the EnsembleClient.
 *
 * This test is SKIPPED by default because it requires the FastAPI sidecar
 * to be reachable on localhost (or wherever ENSEMBLE_SIDECAR_URL points).
 * Boot the sidecar before running:
 *
 *   docker compose up -d ensemble
 *   RUN_ENSEMBLE_INTEGRATION=1 npm test -- __tests__/services
 *   docker compose down
 *
 * The unit-test suite (npm test) should remain green without this flag
 * being set, so CI does not need docker available.
 */

import fs from "node:fs";
import path from "node:path";

import { EnsembleClient } from "@/lib/services/ensemble-client";

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

function parseCsv(filePath: string): Array<Record<string, string | number>> {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string | number> = {};
    header.forEach((column, index) => {
      const raw = cells[index];
      if (raw === undefined || raw === "") {
        row[column] = "";
        return;
      }
      const asNumber = Number(raw);
      row[column] = Number.isFinite(asNumber) && raw.trim() !== "" ? asNumber : raw;
    });
    return row;
  });
}

(RUN ? describe : describe.skip)("EnsembleClient integration", () => {
  const client = new EnsembleClient({ timeoutMs: 180_000 });
  let rows: Array<Record<string, unknown>>;

  beforeAll(() => {
    rows = parseCsv(FIXTURE);
    if (rows.length < 100) {
      throw new Error(`Fixture too small (${rows.length} rows); regenerate.`);
    }
  });

  it("reports healthy", async () => {
    const health = await client.health();
    expect(["ok", "degraded"]).toContain(health.status);
    expect(Array.isArray(health.models_available)).toBe(true);
    expect(health.models_available).toEqual(expect.arrayContaining(["naive", "dow_average"]));
  });

  it("trains and predicts against the real fixture", async () => {
    const trained = await client.train({
      csvRows: rows,
      targetColumns: ["Total_Census"],
    });
    expect(trained.trained_columns).toEqual(["Total_Census"]);
    const weightTotal = Object.values(trained.slsqp_weights.Total_Census).reduce(
      (a, b) => a + b,
      0,
    );
    expect(weightTotal).toBeGreaterThan(0.99);
    expect(weightTotal).toBeLessThan(1.01);

    const prediction = await client.predict({
      csvRows: rows,
      targetColumn: "Total_Census",
    });
    expect(prediction.prediction).toBeGreaterThan(350);
    expect(prediction.prediction).toBeLessThan(900);
    expect(prediction.lower_95).toBeLessThanOrEqual(prediction.prediction);
    expect(prediction.upper_95).toBeGreaterThanOrEqual(prediction.prediction);
    expect(Object.keys(prediction.model_weights).length).toBeGreaterThanOrEqual(3);

    const actual = Number(rows[rows.length - 1].Total_Census);
    const outcome = await client.outcome({
      column: "Total_Census",
      modelPredictions: prediction.individual_predictions,
      actual,
    });
    expect(outcome.observation_count).toBeGreaterThanOrEqual(1);
  });
});
