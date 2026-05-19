/**
 * Unit tests for POST /api/forecast (R6-05).
 *
 * Uses a labelled FAKE fetch passed to the EnsembleClient ONLY so we can
 * verify the route handler's request shape, error translation, and audit
 * emission without booting the Python sidecar in CI. The REAL end-to-end
 * contract is exercised by `__tests__/integration/forecast.integration.test.ts`
 * which boots services/ensemble via docker compose.
 *
 * Per project policy: no mock RESPONSE business data here either — the
 * sidecar response stubs are minimal shape-only fixtures, not realistic
 * forecasts.
 */

import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { EnsembleClient } from "@/lib/services/ensemble-client";
import { POST } from "@/app/api/forecast/route";
import {
  setForecastTestOptions,
  resetForecastTestOptions,
} from "@/lib/forecast/test-hooks";

type FetchArgs = Parameters<typeof fetch>;

const TEST_DATABASE_URL = "file:./forecast.test.db";

function buildFakeFetch(
  responses: Array<{ status: number; body: unknown }>,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method?: string; bodyJson: unknown }>;
} {
  const calls: Array<{ url: string; method?: string; bodyJson: unknown }> = [];
  let index = 0;
  const impl = (async (input: FetchArgs[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    let bodyJson: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        bodyJson = JSON.parse(init.body);
      } catch {
        bodyJson = init.body;
      }
    }
    calls.push({ url, method: init?.method, bodyJson });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, calls };
}

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/forecast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildCsv(rowCount: number): string {
  const header = "DayDate,Value";
  const base = new Date("2025-01-01T00:00:00Z").getTime();
  const lines = [header];
  for (let i = 0; i < rowCount; i++) {
    const d = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
    // Deterministic but realistic-shape numbers (not a "mock forecast",
    // these are real input values to validate plumbing).
    lines.push(`${d},${100 + i + (i % 5)}`);
  }
  return lines.join("\n");
}

describe("POST /api/forecast", () => {
  let prisma: import("@prisma/client").PrismaClient;

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
    ({ prisma } = await import("@/lib/db"));
  }, 30_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
  });

  afterEach(() => {
    resetForecastTestOptions();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("rejects invalid payloads with VALIDATION_ERROR", async () => {
    const response = await POST(
      makeRequest({ csv: "", dateColumn: "", targetColumn: "", horizon: 0 }),
    );
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  test("rejects CSVs whose date column does not parse", async () => {
    const csv = "Date,Value\nnot-a-date,123\nstill-not,456\n";
    const response = await POST(
      makeRequest({ csv, dateColumn: "Date", targetColumn: "Value", horizon: 1 }),
    );
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("INVALID_TIME_SERIES");
  });

  test("calls /train then /predict and returns the forecast plus forecastId", async () => {
    const trainBody = {
      trained_columns: ["Value"],
      slsqp_weights: { Value: { naive: 0.6, arima: 0.4 } },
      training_seconds: 0.5,
      n_rows: 30,
    };
    const predictBody = {
      column: "Value",
      prediction: 110.0,
      lower_95: 105.0,
      upper_95: 115.0,
      model_weights: { naive: 0.6, arima: 0.4 },
      individual_predictions: { naive: 108.0, arima: 112.0 },
      regime_type: "stable",
      rho: 0.1,
      mode: "production",
    };

    const { fetchImpl, calls } = buildFakeFetch([
      { status: 200, body: trainBody },
      { status: 200, body: predictBody },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    setForecastTestOptions({ ensembleClient: client });

    const csv = buildCsv(35);
    const response = await POST(
      makeRequest({
        csv,
        dateColumn: "DayDate",
        targetColumn: "Value",
        horizon: 1,
      }),
    );
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://sidecar-fake/train");
    expect(calls[1].url).toBe("http://sidecar-fake/predict");
    const trainPayload = calls[0].bodyJson as Record<string, unknown>;
    expect(trainPayload.target_columns).toEqual(["Value"]);
    expect(trainPayload.date_column).toBe("DayDate");
    expect(Array.isArray(trainPayload.csv_rows)).toBe(true);

    const predictPayload = calls[1].bodyJson as Record<string, unknown>;
    expect(predictPayload.target_column).toBe("Value");
    expect(predictPayload.n_steps).toBe(1);

    expect(typeof data.forecastId).toBe("string");
    expect((data.forecastId as string).length).toBeGreaterThan(8);
    expect(typeof data.trainedAt).toBe("string");
    expect(data.slsqpWeights).toEqual({ naive: 0.6, arima: 0.4 });
    expect((data.forecast as { prediction: number }).prediction).toBe(110.0);
    expect((data.forecast as { regime_type: string }).regime_type).toBe("stable");

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "forecast_request" },
    });
    expect(audit.metadataJson).toContain('"outcome":"ok"');
    expect(audit.metadataJson).toContain('"targetColumn":"Value"');
    expect(audit.metadataJson).not.toContain("csv_rows");
  });

  test("returns 502 ENSEMBLE_SIDECAR_ERROR when the sidecar returns non-2xx", async () => {
    const { fetchImpl } = buildFakeFetch([
      { status: 503, body: { detail: "ace_hospital not importable: x" } },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    setForecastTestOptions({ ensembleClient: client });

    const csv = buildCsv(35);
    const response = await POST(
      makeRequest({
        csv,
        dateColumn: "DayDate",
        targetColumn: "Value",
        horizon: 1,
      }),
    );
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("ENSEMBLE_SIDECAR_ERROR");
    expect(body.error?.message).toMatch(/503/);
  });

  test("returns 502 ENSEMBLE_SIDECAR_UNREACHABLE on network failure", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl: failingFetch,
    });
    setForecastTestOptions({ ensembleClient: client });

    const csv = buildCsv(35);
    const response = await POST(
      makeRequest({
        csv,
        dateColumn: "DayDate",
        targetColumn: "Value",
        horizon: 1,
      }),
    );
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("ENSEMBLE_SIDECAR_UNREACHABLE");
    expect(body.error?.message).toMatch(/docker compose ps/);
  });
});
