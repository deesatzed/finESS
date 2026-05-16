import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import { runSimulation } from "@/lib/engine/monte-carlo";
import { getAnalysisStatus } from "@/lib/ui/analysis-status";

const TEST_DATABASE_URL = "file:./e2e.test.db";

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

describe("single-user beta workflow", () => {
  let prisma: PrismaClient;
  let analysesRoute: typeof import("@/app/api/analyses/route");
  let analysisRoute: typeof import("@/app/api/analyses/[id]/route");
  let calibrationRoute: typeof import("@/app/api/calibration/route");

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
  }, 30_000);

  beforeEach(async () => {
    await prisma.calibrationOutcome.deleteMany();
    await prisma.analysis.deleteMany();
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
      })
    );
    const saved = await readJson(save);
    expect(save.status).toBe(201);

    const loadedResponse = await analysisRoute.GET(
      makeRequest(`/api/analyses/${saved.id}`, undefined, "GET"),
      { params: { id: saved.id as string } }
    );
    const loaded = await readJson(loadedResponse);
    expect(loadedResponse.status).toBe(200);
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
      })
    );
    expect(calibration.status).toBe(201);

    const curve = await calibrationRoute.GET();
    const curveBody = await readJson(curve);
    expect(curve.status).toBe(200);
    expect(curveBody.count).toBe(1);
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
