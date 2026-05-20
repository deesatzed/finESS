/**
 * Semantic Mode B5a — live integration test.
 *
 * Boots-or-assumes the Python ensemble sidecar (services/ensemble) at
 * ENSEMBLE_SIDECAR_URL and runs `researchForecast` against the real
 * fixture at services/ensemble/fixtures/hospital-census-sample.csv.
 *
 * SKIPPED by default. To run:
 *
 *   docker compose up -d ensemble
 *   curl -fsS http://localhost:8001/health
 *   RUN_ENSEMBLE_INTEGRATION=1 npx jest \
 *     __tests__/integration/semantic-research-forecast.integration.test.ts --runInBand
 *   docker compose down
 *
 * The Jest harness here cannot start docker itself; the docker-compose
 * step is documented above and mirrors the gating pattern used by the
 * existing forecast.integration.test.ts. Assertions check the bundle
 * SHAPE (mechanism, distribution, citations[*].source prefix), not
 * specific numeric values — the underlying ensemble weights and
 * predictions can shift across releases of ace_hospital and we do not
 * want to lock the test to a specific release.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCsvText } from "@/lib/real-data/csv";

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

(RUN ? describe : describe.skip)(
  "researchForecast (live ensemble)",
  () => {
    let researchForecast: typeof import("@/lib/semantic/research/forecast").researchForecast;

    beforeAll(async () => {
      ({ researchForecast } = await import(
        "@/lib/semantic/research/forecast"
      ));
    }, 60_000);

    it("produces a real ensemble_forecast ResearchBundle from the hospital census fixture", async () => {
      const csvText = fs.readFileSync(FIXTURE, "utf8");
      const parsed = parseCsvText(csvText);
      // The sidecar accepts string-or-number cells; rows from parseCsvText
      // are already Record<string, string> which satisfies the type.
      expect(parsed.rows.length).toBeGreaterThan(100);

      const result = await researchForecast({
        component: {
          id: "next_day_census",
          name: "Next Day Census",
          description: "Predicted hospital census for the next day.",
          suggestedDistribution: "normal",
        },
        csvRows: parsed.rows,
        dateColumn: "DayDate",
        targetColumn: "Total_Census",
        horizon: 1,
      });

      expect(result.bundle.mechanism).toBe("ensemble_forecast");
      expect(result.bundle.proposedDistribution).toBe("normal");
      expect(typeof result.bundle.proposedParams.mean).toBe("number");
      expect(Number.isFinite(result.bundle.proposedParams.mean!)).toBe(true);
      expect(typeof result.bundle.proposedParams.sd).toBe("number");
      expect(result.bundle.proposedParams.sd!).toBeGreaterThan(0);
      expect(result.bundle.componentId).toBe("next_day_census");
      expect(result.bundle.citations.length).toBeGreaterThanOrEqual(3);
      for (const c of result.bundle.citations) {
        expect(c.source.startsWith("ensemble-model:")).toBe(true);
        expect(c.snippet).toMatch(/weight=/);
        expect(c.snippet).toMatch(/prediction=/);
      }

      const weights = Object.values(result.perModelWeights);
      const weightSum = weights.reduce((a, b) => a + b, 0);
      expect(weightSum).toBeGreaterThan(0.99);
      expect(weightSum).toBeLessThan(1.01);
      expect(result.ensembleLatencyMs).toBeGreaterThanOrEqual(0);
    }, 180_000);
  },
);
