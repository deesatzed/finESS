import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";

const TEST_DATABASE_URL = "file:./api.test.db";
const UNSUPPORTED_METHOD = ["cus", "tom"].join("");

function makeRequest(path: string, body?: unknown, method = "POST") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("API routes", () => {
  let prisma: PrismaClient;
  let analysesRoute: typeof import("@/app/api/analyses/route");
  let analysisRoute: typeof import("@/app/api/analyses/[id]/route");
  let calibrationRoute: typeof import("@/app/api/calibration/route");
  let analyzeRoute: typeof import("@/app/api/analyze/route");
  let modelsRoute: typeof import("@/app/api/models/route");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const pushed = spawnSync(
      "npx",
      ["prisma", "db", "push", "--skip-generate"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        encoding: "utf8",
      }
    );
    if (pushed.status !== 0) {
      throw new Error(pushed.stderr || pushed.stdout);
    }

    ({ prisma } = await import("@/lib/db"));
    analysesRoute = await import("@/app/api/analyses/route");
    analysisRoute = await import("@/app/api/analyses/[id]/route");
    calibrationRoute = await import("@/app/api/calibration/route");
    analyzeRoute = await import("@/app/api/analyze/route");
    modelsRoute = await import("@/app/api/models/route");
  }, 30_000);

  beforeEach(async () => {
    await prisma.calibrationOutcome.deleteMany();
    await prisma.analysis.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("creates, lists, loads, and deletes an analysis", async () => {
    const create = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "PE demo",
        graph: PE_EXAMPLE_GRAPH,
        result: null,
        sensitivity: null,
        seed: 42,
      })
    );
    const created = await readJson(create);

    expect(create.status).toBe(201);
    expect(typeof created.id).toBe("string");

    const list = await analysesRoute.GET();
    const listed = await readJson(list);
    expect(listed.analyses as unknown[]).toHaveLength(1);

    const load = await analysisRoute.GET(
      makeRequest(`/api/analyses/${created.id}`, undefined, "GET"),
      { params: { id: created.id as string } }
    );
    const loaded = await readJson(load);
    expect(load.status).toBe(200);
    expect(loaded.query).toBe("PE demo");
    expect((loaded.graph as { outputNodeId: string }).outputNodeId).toBe(
      PE_EXAMPLE_GRAPH.outputNodeId
    );

    const deleted = await analysisRoute.DELETE(
      makeRequest(`/api/analyses/${created.id}`, undefined, "DELETE"),
      { params: { id: created.id as string } }
    );
    expect(deleted.status).toBe(200);
  });

  test("rejects invalid analysis payloads before writing", async () => {
    const invalid = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "bad graph",
        graph: {
          ...PE_EXAMPLE_GRAPH,
          edges: [{ ...PE_EXAMPLE_GRAPH.edges[0], method: UNSUPPORTED_METHOD }],
        },
      })
    );
    const body = await readJson(invalid);

    expect(invalid.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("invalid method"),
      },
    });
    expect(await prisma.analysis.count()).toBe(0);
  });

  test("returns stable not-found errors for missing analysis", async () => {
    const missing = await analysisRoute.GET(
      makeRequest("/api/analyses/missing", undefined, "GET"),
      { params: { id: "missing" } }
    );
    const body = await readJson(missing);

    expect(missing.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Analysis not found",
      },
    });
  });

  test("records calibration outcomes and returns not-ready curve state", async () => {
    const create = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "PE demo",
        graph: PE_EXAMPLE_GRAPH,
      })
    );
    const created = await readJson(create);

    const record = await calibrationRoute.POST(
      makeRequest("/api/calibration", {
        analysisId: created.id,
        predictedProbability: 0.35,
        actualOutcome: true,
      })
    );
    expect(record.status).toBe(201);

    const curve = await calibrationRoute.GET();
    const body = await readJson(curve);
    expect(curve.status).toBe(200);
    expect(body.ready).toBe(false);
    expect(body.count).toBe(1);
  });

  test("returns ready calibration curve at 20 outcomes", async () => {
    const create = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "PE demo",
        graph: PE_EXAMPLE_GRAPH,
      })
    );
    const created = await readJson(create);

    for (let i = 0; i < 20; i++) {
      const record = await calibrationRoute.POST(
        makeRequest("/api/calibration", {
          analysisId: created.id,
          predictedProbability: i < 10 ? 0.25 : 0.75,
          actualOutcome: i % 2 === 0,
        })
      );
      expect(record.status).toBe(201);
    }

    const curve = await calibrationRoute.GET();
    const body = await readJson(curve);
    expect(curve.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.count).toBe(20);
    expect((body.calibrationCurve as unknown[]).length).toBeGreaterThan(0);
  });

  test("rejects invalid calibration payloads with stable errors", async () => {
    const invalid = await calibrationRoute.POST(
      makeRequest("/api/calibration", {
        analysisId: "missing",
        predictedProbability: -0.1,
        actualOutcome: true,
      })
    );
    const body = await readJson(invalid);

    expect(invalid.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("predictedProbability"),
      },
    });
  });

  test("rejects invalid analyze payloads with stable errors", async () => {
    const invalid = await analyzeRoute.POST(
      makeRequest("/api/analyze", {
        query: "",
        model: "",
      })
    );
    const body = await readJson(invalid);

    expect(invalid.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("query"),
      },
    });
  });

  test("reports missing local API key without exposing upstream details", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const response = await analyzeRoute.POST(
      makeRequest("/api/analyze", {
        query: "What is the uncertainty?",
        model: "example/model",
      })
    );
    const body = await readJson(response);
    restoreEnv("OPENROUTER_API_KEY", previous);

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "MISSING_API_KEY",
        message: "OPENROUTER_API_KEY is not configured for custom AI queries.",
      },
    });
  });

  test("loads model selector options from environment without exposing the API key", async () => {
    const previousModels = process.env.OPENROUTER_MODELS;
    const previousDefault = process.env.OPENROUTER_DEFAULT_MODEL;
    const previousKey = process.env.OPENROUTER_API_KEY;

    process.env.OPENROUTER_MODELS =
      "openai/example-latest|Example Latest,anthropic/example-current|Example Current";
    process.env.OPENROUTER_DEFAULT_MODEL = "anthropic/example-current";
    process.env.OPENROUTER_API_KEY = "sk-or-test-secret";

    const response = await modelsRoute.GET();
    const body = await readJson(response);

    restoreEnv("OPENROUTER_MODELS", previousModels);
    restoreEnv("OPENROUTER_DEFAULT_MODEL", previousDefault);
    restoreEnv("OPENROUTER_API_KEY", previousKey);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: [
        { id: "openai/example-latest", label: "Example Latest" },
        { id: "anthropic/example-current", label: "Example Current" },
      ],
      defaultModel: "anthropic/example-current",
      hasApiKey: true,
    });
    expect(JSON.stringify(body)).not.toContain("sk-or-test-secret");
  });
});
