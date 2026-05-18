/**
 * Unit tests for EnsembleClient.
 *
 * These tests inject a fake `fetch` so they run in CI without the Python
 * sidecar. The live integration counterpart (`ensemble-client.integration.test.ts`)
 * is the contract test that actually exercises the FastAPI service.
 *
 * Per project policy: no mock RESPONSE DATA — the assertions are about
 * request shape and error translation only. Real ensemble payloads are
 * exercised in the integration suite.
 */

import { EnsembleClient, EnsembleClientError } from "@/lib/services/ensemble-client";

type FetchArgs = Parameters<typeof fetch>;

function makeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetchImpl = (async (input: FetchArgs[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, init });
    const next = responses[index] ?? responses[responses.length - 1];
    index += 1;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("EnsembleClient", () => {
  it("requests /health with GET and parses the response", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          status: "ok",
          ensemble_version: "0.1.0",
          chronos_enabled: false,
          chronos_size: "tiny",
          models_available: ["naive", "dow_average"],
          trained_columns: [],
        },
      },
    ]);
    const client = new EnsembleClient({ baseUrl: "http://example", fetchImpl });
    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(calls[0].url).toBe("http://example/health");
    expect(calls[0].init?.method).toBe("GET");
  });

  it("normalises trailing slashes in baseUrl", async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: { status: "ok", ensemble_version: "x", chronos_enabled: false, chronos_size: null, models_available: [], trained_columns: [] } },
    ]);
    const client = new EnsembleClient({ baseUrl: "http://example/", fetchImpl });
    await client.health();
    expect(calls[0].url).toBe("http://example/health");
  });

  it("sends /train with snake_case payload", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          trained_columns: ["Total_Census"],
          slsqp_weights: { Total_Census: { naive: 1.0 } },
          training_seconds: 0.5,
          n_rows: 100,
        },
      },
    ]);
    const client = new EnsembleClient({ baseUrl: "http://example", fetchImpl });
    const result = await client.train({
      csvRows: [{ DayDate: "2024-01-01", Total_Census: 250 }],
      targetColumns: ["Total_Census"],
    });
    expect(result.trained_columns).toEqual(["Total_Census"]);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      csv_rows: [{ DayDate: "2024-01-01", Total_Census: 250 }],
      date_column: "DayDate",
      target_columns: ["Total_Census"],
      train_fraction: 0.6,
      val_fraction: 0.2,
      weight_priors: null,
    });
  });

  it("sends /predict with defaults filled in", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          column: "Total_Census",
          prediction: 612.0,
          lower_95: 600.0,
          upper_95: 624.0,
          model_weights: { naive: 1.0 },
          individual_predictions: { naive: 612.0 },
          regime_type: "stable",
          rho: 0.7,
          mode: "production",
        },
      },
    ]);
    const client = new EnsembleClient({ baseUrl: "http://example", fetchImpl });
    await client.predict({ csvRows: [], targetColumn: "Total_Census" });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.target_column).toBe("Total_Census");
    expect(body.n_steps).toBe(1);
    expect(body.use_latest_priors).toBe(true);
    expect(body.date_column).toBe("DayDate");
  });

  it("translates non-2xx responses to EnsembleClientError", async () => {
    const { fetchImpl } = makeFetch([
      { status: 409, body: { detail: "No trained ensemble." } },
    ]);
    const client = new EnsembleClient({ baseUrl: "http://example", fetchImpl });
    await expect(
      client.predict({ csvRows: [], targetColumn: "Total_Census" }),
    ).rejects.toBeInstanceOf(EnsembleClientError);
  });

  it("sends /outcome with model_predictions mapped through", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          column: "Total_Census",
          updated_priors: {
            naive: { type: "beta", params: { alpha: 1.1, beta: 1.9 } },
          },
          observation_count: 3,
          note: "...",
        },
      },
    ]);
    const client = new EnsembleClient({ baseUrl: "http://example", fetchImpl });
    const result = await client.outcome({
      column: "Total_Census",
      modelPredictions: { naive: 610.0, arima: 615.0 },
      actual: 612.0,
    });
    expect(result.observation_count).toBe(3);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      column: "Total_Census",
      model_predictions: { naive: 610.0, arima: 615.0 },
      actual: 612.0,
    });
  });
});
