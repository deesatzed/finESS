import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import { runSimulation } from "@/lib/engine/monte-carlo";
import { analyzeObservedRows } from "@/lib/real-data/analyze";
import { getAnalysisStatus } from "@/lib/ui/analysis-status";
import type { LocalAuthSession } from "@/lib/auth/local-session";

const TEST_DATABASE_URL = "file:./e2e.test.db";

function makeRequest(
  path: string,
  body?: unknown,
  method = "POST",
  session?: LocalAuthSession
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (session) headers.Cookie = `finess_local_session=${session.token}`;

  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("single-user beta workflow", () => {
  let prisma: PrismaClient;
  let analysesRoute: typeof import("@/app/api/analyses/route");
  let analysisRoute: typeof import("@/app/api/analyses/[id]/route");
  let calibrationRoute: typeof import("@/app/api/calibration/route");
  let modelsRoute: typeof import("@/app/api/models/route");
  let realDataAssistRoute: typeof import("@/app/api/real-data/assist/route");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let session: LocalAuthSession;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const pushed = spawnSync("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      encoding: "utf8",
    });
    if (pushed.status !== 0) {
      throw new Error(pushed.stderr || pushed.stdout);
    }

    ({ prisma } = await import("@/lib/db"));
    analysesRoute = await import("@/app/api/analyses/route");
    analysisRoute = await import("@/app/api/analyses/[id]/route");
    calibrationRoute = await import("@/app/api/calibration/route");
    modelsRoute = await import("@/app/api/models/route");
    realDataAssistRoute = await import("@/app/api/real-data/assist/route");
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));
  }, 30_000);

  beforeEach(async () => {
    await prisma.calibrationOutcome.deleteMany();
    await prisma.analysis.deleteMany();
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    session = await createLocalAuthSession("e2e-owner");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("PE demo can be simulated, saved, loaded, and calibrated locally", async () => {
    const result = runSimulation(PE_EXAMPLE_GRAPH, {
      numSamples: 500,
      batchSize: 100,
      seed: 42,
    });

    const unsaved = getAnalysisStatus({
      hasGraph: true,
      hasResult: true,
      phase: "complete",
      savedAnalysisId: null,
      hasUnsavedChanges: true,
    });
    expect(unsaved.canSave).toBe(true);
    expect(unsaved.canCalibrate).toBe(false);

    const save = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "PE clinical scenario (pre-built demo)",
        graph: PE_EXAMPLE_GRAPH,
        result,
        sensitivity: [],
        seed: result.seed,
      }, "POST", session)
    );
    const saved = await readJson(save);
    expect(save.status).toBe(201);
    expect(saved.userId).toBe(session.userId);
    expect(saved.workspaceId).toBe(session.workspaceId);

    const loadedResponse = await analysisRoute.GET(
      makeRequest(`/api/analyses/${saved.id}`, undefined, "GET", session),
      { params: { id: saved.id as string } }
    );
    const loaded = await readJson(loadedResponse);
    expect(loadedResponse.status).toBe(200);
    expect(loaded.userId).toBe(session.userId);
    expect(loaded.workspaceId).toBe(session.workspaceId);
    expect((loaded.graph as { outputNodeId: string }).outputNodeId).toBe("output");

    const savedStatus = getAnalysisStatus({
      hasGraph: true,
      hasResult: true,
      phase: "complete",
      savedAnalysisId: saved.id as string,
      hasUnsavedChanges: false,
    });
    expect(savedStatus.canCalibrate).toBe(true);

    const calibration = await calibrationRoute.POST(
      makeRequest("/api/calibration", {
        analysisId: saved.id,
        predictedProbability: result.pAboveThreshold,
        actualOutcome: true,
      }, "POST", session)
    );
    expect(calibration.status).toBe(201);

    const curve = await calibrationRoute.GET(
      makeRequest("/api/calibration", undefined, "GET", session)
    );
    const curveBody = await readJson(curve);
    expect(curve.status).toBe(200);
    expect(curveBody.count).toBe(1);
  });

  test("unauthenticated workflow requests are denied before persistence", async () => {
    const save = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "PE clinical scenario (pre-built demo)",
        graph: PE_EXAMPLE_GRAPH,
      })
    );
    const calibration = await calibrationRoute.GET(
      makeRequest("/api/calibration", undefined, "GET")
    );

    expect(save.status).toBe(401);
    expect(calibration.status).toBe(401);
  });

  test("observed CSV workflow assists, saves, loads, and calibrates real rows", async () => {
    const previousModels = process.env.OPENROUTER_MODELS;
    const previousDefault = process.env.OPENROUTER_DEFAULT_MODEL;
    process.env.OPENROUTER_MODELS = "openrouter/auto|OpenRouter Auto";
    process.env.OPENROUTER_DEFAULT_MODEL = "openrouter/auto";

    const modelResponse = await modelsRoute.GET();
    const modelBody = await readJson(modelResponse);
    expect(modelResponse.status).toBe(200);
    expect(modelBody.models).toEqual([
      { id: "openrouter/auto", label: "OpenRouter Auto" },
    ]);

    const observed = analyzeObservedRows(
      [
        { outcome: "yes" },
        { outcome: "no" },
        { outcome: "yes" },
        { outcome: "yes" },
      ],
      "outcome"
    );

    const previousKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const previousFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Observed outcome rate is 75%.",
                cautions: ["Only four rows are present."],
                nextChecks: ["Collect more outcomes before relying on calibration."],
              }),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const assist = await realDataAssistRoute.POST(
      makeRequest("/api/real-data/assist", {
        query: "Observed CSV: outcome (4 rows)",
        targetColumn: observed.targetColumn,
        rowCount: observed.rowCount,
        missingCount: observed.missingCount,
        mean: observed.result.mean,
        median: observed.result.median,
        ciLow: observed.result.ciLow,
        ciHigh: observed.result.ciHigh,
        pAboveThreshold: observed.result.pAboveThreshold,
        threshold: observed.graph.threshold ?? null,
        model: "openrouter/auto",
        apiKey: "sk-or-runtime-secret",
      })
    );
    const assistBody = await readJson(assist);
    expect(assist.status).toBe(200);
    expect(assistBody).toEqual({
      insight: {
        summary: "Observed outcome rate is 75%.",
        cautions: ["Only four rows are present."],
        nextChecks: ["Collect more outcomes before relying on calibration."],
      },
    });
    expect(JSON.stringify(assistBody)).not.toContain("sk-or-runtime-secret");

    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModels === undefined) delete process.env.OPENROUTER_MODELS;
    else process.env.OPENROUTER_MODELS = previousModels;
    if (previousDefault === undefined) delete process.env.OPENROUTER_DEFAULT_MODEL;
    else process.env.OPENROUTER_DEFAULT_MODEL = previousDefault;

    const save = await analysesRoute.POST(
      makeRequest("/api/analyses", {
        query: "Observed CSV: outcome (4 rows)",
        graph: observed.graph,
        result: observed.result,
        sensitivity: observed.sensitivity,
        seed: observed.result.seed,
      }, "POST", session)
    );
    const saved = await readJson(save);
    expect(save.status).toBe(201);

    const loadedResponse = await analysisRoute.GET(
      makeRequest(`/api/analyses/${saved.id}`, undefined, "GET", session),
      { params: { id: saved.id as string } }
    );
    const loaded = await readJson(loadedResponse);
    expect(loadedResponse.status).toBe(200);
    expect((loaded.graph as { analysisMode?: string }).analysisMode).toBe("observed");
    expect((loaded.result as { samples: number[] }).samples).toEqual([1, 0, 1, 1]);

    const calibration = await calibrationRoute.POST(
      makeRequest("/api/calibration", {
        analysisId: saved.id,
        predictedProbability: observed.result.pAboveThreshold,
        actualOutcome: true,
      }, "POST", session)
    );
    expect(calibration.status).toBe(201);
  });

  test("custom query without a model is rejected before any provider call", async () => {
    const analyzeRoute = await import("@/app/api/analyze/route");

    const response = await analyzeRoute.POST(
      makeRequest("/api/analyze", {
        query: "Model this uncertainty",
        model: "",
      })
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("model"),
      },
    });
  });
});
