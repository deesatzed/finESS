/**
 * Unit tests for the R6-06 calibration -> sidecar handoff inside
 * POST /api/calibration.
 *
 * Uses a labelled FAKE fetch passed to the EnsembleClient ONLY so we can
 * verify the route handler's request shape, error translation, and audit
 * emission without booting the Python sidecar in CI. The REAL end-to-end
 * contract is exercised by `__tests__/integration/calibration-loop.integration.test.ts`
 * which boots services/ensemble via docker compose.
 *
 * Per project policy: the sidecar response stubs are minimal shape-only
 * fixtures, not realistic forecasts. They prove the wiring; the live
 * integration test proves the math.
 */

import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { EnsembleClient } from "@/lib/services/ensemble-client";
import type { LocalAuthSession } from "@/lib/auth/local-session";

const TEST_DATABASE_URL = "file:./calibration-feedback.test.db";

type FetchArgs = Parameters<typeof fetch>;

function buildFakeFetch(
  responses: Array<{ status: number; body: unknown } | { throwMessage: string }>,
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
    if ("throwMessage" in next) {
      throw new Error(next.throwMessage);
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl: impl, calls };
}

function makeRequest(body: unknown, session: LocalAuthSession) {
  return new NextRequest("http://localhost/api/calibration", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `finess_local_session=${session.token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/calibration -> sidecar handoff (R6-06)", () => {
  let prisma: import("@prisma/client").PrismaClient;
  let calibrationRoute: typeof import("@/app/api/calibration/route");
  let calibrationHooks: typeof import("@/lib/calibration/test-hooks");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let owner: LocalAuthSession;

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
    calibrationRoute = await import("@/app/api/calibration/route");
    calibrationHooks = await import("@/lib/calibration/test-hooks");
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));
  }, 30_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.calibrationOutcome.deleteMany();
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    owner = await createLocalAuthSession("owner-cal-feedback");
  });

  afterEach(() => {
    calibrationHooks.resetCalibrationTestOptions();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("forwards forecast outcome to sidecar and returns priorsUpdated", async () => {
    const sidecarBody = {
      column: "Total_Census",
      updated_priors: {
        naive: { type: "beta", params: { alpha: 1.2, beta: 8.8 } },
        arima: { type: "beta", params: { alpha: 6.0, beta: 4.0 } },
      },
      observation_count: 3,
    };
    const { fetchImpl, calls } = buildFakeFetch([
      { status: 200, body: sidecarBody },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    calibrationHooks.setCalibrationTestOptions({ ensembleClient: client });

    const response = await calibrationRoute.POST(
      makeRequest(
        {
          forecastId: "forecast-abc-123",
          predictedProbability: 0.5,
          actualOutcome: true,
          targetColumn: "Total_Census",
          modelPredictions: { naive: 100, arima: 110 },
          actualValue: 105,
        },
        owner,
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.sidecarStatus).toBe("updated");
    expect(body.observationCount).toBe(3);
    expect(body.priorsUpdated).toEqual(sidecarBody.updated_priors);

    // Sidecar was called with the correct payload shape.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://sidecar-fake/outcome");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].bodyJson).toEqual({
      column: "Total_Census",
      model_predictions: { naive: 100, arima: 110 },
      actual: 105,
    });

    // SQLite row was persisted.
    const persisted = await prisma.calibrationOutcome.findFirstOrThrow();
    expect(persisted.forecastId).toBe("forecast-abc-123");
    expect(persisted.analysisId).toBeNull();
    expect(persisted.predictedProbability).toBeCloseTo(0.5);
    expect(persisted.actualOutcome).toBe(true);

    // Two audit events: calibration.record + forecast_outcome_recorded.
    const audits = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "asc" },
      select: { eventType: true, metadataJson: true },
    });
    expect(audits.map((a) => a.eventType)).toEqual([
      "calibration.record",
      "forecast_outcome_recorded",
    ]);
    expect(audits[1].metadataJson).toContain('"outcome":"updated"');
    expect(audits[1].metadataJson).toContain('"observationCount":3');
    expect(audits[1].metadataJson).toContain('"forecastId":"forecast-abc-123"');
    // The sanitiser must NEVER leak the model predictions to the audit log.
    expect(audits[1].metadataJson).not.toContain("model_predictions");
  });

  test("persists SQLite row and reports sidecarStatus=down when sidecar is unreachable", async () => {
    const { fetchImpl } = buildFakeFetch([{ throwMessage: "ECONNREFUSED" }]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    calibrationHooks.setCalibrationTestOptions({ ensembleClient: client });

    const response = await calibrationRoute.POST(
      makeRequest(
        {
          forecastId: "forecast-down",
          predictedProbability: 0.5,
          actualOutcome: false,
          targetColumn: "Total_Census",
          modelPredictions: { naive: 50 },
          actualValue: 60,
        },
        owner,
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.sidecarStatus).toBe("down");
    expect(typeof body.sidecarReason).toBe("string");
    expect((body.sidecarReason as string).toLowerCase()).toContain("econnrefused");
    expect(body.priorsUpdated).toBeUndefined();

    // SQLite still saved the outcome (the loop is best-effort).
    expect(await prisma.calibrationOutcome.count()).toBe(1);

    // Audit recorded the failure.
    const audits = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "asc" },
      select: { eventType: true, metadataJson: true },
    });
    expect(audits.map((a) => a.eventType)).toEqual([
      "calibration.record",
      "forecast_outcome_recorded",
    ]);
    expect(audits[1].metadataJson).toContain('"outcome":"down"');
  });

  test("reports sidecarStatus=error when sidecar returns non-2xx", async () => {
    const { fetchImpl } = buildFakeFetch([
      { status: 500, body: { detail: "EMA learner unavailable" } },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    calibrationHooks.setCalibrationTestOptions({ ensembleClient: client });

    const response = await calibrationRoute.POST(
      makeRequest(
        {
          forecastId: "forecast-error",
          predictedProbability: 0.6,
          actualOutcome: true,
          targetColumn: "Total_Census",
          modelPredictions: { naive: 1, arima: 2 },
          actualValue: 1.5,
        },
        owner,
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.sidecarStatus).toBe("error");
    expect(body.sidecarReason).toContain("500");
    expect(await prisma.calibrationOutcome.count()).toBe(1);
  });

  test("does NOT call the sidecar when forecastId is present without the feedback trio", async () => {
    const { fetchImpl, calls } = buildFakeFetch([
      { status: 200, body: { ok: true } },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    calibrationHooks.setCalibrationTestOptions({ ensembleClient: client });

    const response = await calibrationRoute.POST(
      makeRequest(
        {
          forecastId: "forecast-no-trio",
          predictedProbability: 0.5,
          actualOutcome: true,
        },
        owner,
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.sidecarStatus).toBe("skipped");
    expect(calls).toHaveLength(0);

    // Only the calibration.record audit, no forecast_outcome_recorded.
    const audits = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "asc" },
      select: { eventType: true },
    });
    expect(audits.map((a) => a.eventType)).toEqual(["calibration.record"]);
  });

  test("rejects half-built forecast feedback payloads at the validation layer", async () => {
    const { fetchImpl, calls } = buildFakeFetch([
      { status: 200, body: { ok: true } },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    calibrationHooks.setCalibrationTestOptions({ ensembleClient: client });

    const response = await calibrationRoute.POST(
      makeRequest(
        {
          forecastId: "forecast-half",
          predictedProbability: 0.5,
          actualOutcome: true,
          // targetColumn provided but modelPredictions / actualValue missing.
          targetColumn: "Total_Census",
        },
        owner,
      ),
    );
    const body = (await response.json()) as { error?: { code?: string } };
    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
    expect(calls).toHaveLength(0);
    // Nothing persisted.
    expect(await prisma.calibrationOutcome.count()).toBe(0);
  });

  test("analysis-branch outcomes still skip the sidecar (no forecastId)", async () => {
    // Create a real analysis owned by `owner` so the route's ownership
    // check passes.
    const { POST: analysesPost } = await import("@/app/api/analyses/route");
    const { PE_EXAMPLE_GRAPH } = await import("@/lib/examples/pe-scenario");
    const created = await analysesPost(
      new NextRequest("http://localhost/api/analyses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `finess_local_session=${owner.token}`,
        },
        body: JSON.stringify({
          query: "calibration feedback baseline",
          graph: PE_EXAMPLE_GRAPH,
        }),
      }),
    );
    const createdBody = (await created.json()) as { id: string };

    const { fetchImpl, calls } = buildFakeFetch([
      { status: 200, body: { ok: true } },
    ]);
    const client = new EnsembleClient({
      baseUrl: "http://sidecar-fake",
      fetchImpl,
    });
    calibrationHooks.setCalibrationTestOptions({ ensembleClient: client });

    const response = await calibrationRoute.POST(
      makeRequest(
        {
          analysisId: createdBody.id,
          predictedProbability: 0.5,
          actualOutcome: true,
        },
        owner,
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(201);
    expect(body.sidecarStatus).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});
