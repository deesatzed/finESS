/**
 * B6 integration: PATCH /api/semantic/[id] with a `startResearch` event
 * fires the corresponding research adapter server-side and applies the
 * resulting `researchReceived` (or `fail`) event before responding.
 *
 * Adapters are mocked at the module boundary; this file is testing the
 * route's wiring (validator → reducer → autoAdvance dispatcher) end to
 * end against a real Prisma DB (via the same db-push pattern as the
 * other API tests).
 */

import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import type { LocalAuthSession } from "@/lib/auth/local-session";

// Adapter mocks. Must be in place BEFORE the route handlers import them
// transitively via @/lib/semantic/auto-advance.
jest.mock("@/lib/semantic/research/llm-prior", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/llm-prior")
  >("@/lib/semantic/research/llm-prior");
  return { ...actual, researchLlmPrior: jest.fn() };
});
jest.mock("@/lib/semantic/research/web", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/web")
  >("@/lib/semantic/research/web");
  return { ...actual, researchWeb: jest.fn() };
});
jest.mock("@/lib/semantic/research/expert-panel", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/research/expert-panel")
  >("@/lib/semantic/research/expert-panel");
  return { ...actual, researchExpertPanel: jest.fn() };
});

// Mock A3 + A4 too — POST creates a conversation that immediately
// auto-advances; if real OpenRouter is reached the test would block.
jest.mock("@/lib/semantic/clarify", () => {
  const actual = jest.requireActual<typeof import("@/lib/semantic/clarify")>(
    "@/lib/semantic/clarify",
  );
  return { ...actual, requestClarifications: jest.fn() };
});
jest.mock("@/lib/semantic/propose-components", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/semantic/propose-components")
  >("@/lib/semantic/propose-components");
  return { ...actual, proposeComponents: jest.fn() };
});

import { researchLlmPrior } from "@/lib/semantic/research/llm-prior";
import { researchWeb } from "@/lib/semantic/research/web";
import { researchExpertPanel } from "@/lib/semantic/research/expert-panel";
import { requestClarifications } from "@/lib/semantic/clarify";
import { proposeComponents } from "@/lib/semantic/propose-components";
import type { ResearchBundle } from "@/lib/semantic/types";

const mockLlmPrior =
  researchLlmPrior as jest.MockedFunction<typeof researchLlmPrior>;
const mockWeb = researchWeb as jest.MockedFunction<typeof researchWeb>;
const mockExpertPanel =
  researchExpertPanel as jest.MockedFunction<typeof researchExpertPanel>;
const mockClarify =
  requestClarifications as jest.MockedFunction<typeof requestClarifications>;
const mockPropose =
  proposeComponents as jest.MockedFunction<typeof proposeComponents>;

const TEST_DATABASE_URL = "file:./semantic-research-event.test.db";

function makeRequest(
  path: string,
  body?: unknown,
  method = "POST",
  session?: LocalAuthSession,
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

function bundle(componentId: string, mechanism: ResearchBundle["mechanism"]): ResearchBundle {
  return {
    componentId,
    mechanism,
    proposedDistribution: "normal",
    proposedParams: { mean: 50, sd: 10 },
    reasoning: "synthetic test reasoning",
  };
}

describe("Semantic API — startResearch event dispatch", () => {
  let prisma: PrismaClient;
  let semanticRoute: typeof import("@/app/api/semantic/route");
  let semanticIdRoute: typeof import("@/app/api/semantic/[id]/route");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let owner: LocalAuthSession;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // Make sure OPENROUTER_API_KEY is set so the route fires
    // auto-advance for non-startResearch events. The mocked adapters
    // catch the call before any real network goes out.
    process.env.OPENROUTER_API_KEY = "test-key";
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
    semanticRoute = await import("@/app/api/semantic/route");
    semanticIdRoute = await import("@/app/api/semantic/[id]/route");
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));
  }, 30_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.semanticConversation.deleteMany();
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    owner = await createLocalAuthSession("owner-rsx");

    mockLlmPrior.mockReset();
    mockWeb.mockReset();
    mockExpertPanel.mockReset();
    mockClarify.mockReset();
    mockPropose.mockReset();

    // Default A3 / A4 stubs walk a tiny conversation through to
    // SETTING_THRESHOLD without burning tokens.
    mockClarify.mockResolvedValue({
      questions: [{ id: "q1", question: "Scope?" }],
      model: "test-model",
      latencyMs: 1,
      costUsd: 0,
      retryCount: 0,
    });
    mockPropose.mockResolvedValue({
      components: [
        {
          id: "c1",
          name: "C1",
          description: "desc",
          suggestedDistribution: "normal",
        },
      ],
      model: "test-model",
      latencyMs: 1,
      costUsd: 0,
      retryCount: 0,
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /** Walk the conversation forward to RESEARCHING. */
  async function setupResearchingConversation(): Promise<string> {
    const created = (await readJson(
      await semanticRoute.POST(
        makeRequest("/api/semantic", { query: "q" }, "POST", owner),
      ),
    )) as { id: string; state: { kind: string } };
    // After POST + auto-advance: AWAITING_ANSWERS.
    // Drive to SETTING_THRESHOLD.
    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        {
          event: { type: "answerClarification", qId: "q1", answer: "a" },
        },
        "PATCH",
        owner,
      ),
      { params: { id: created.id } },
    );
    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        { event: { type: "submitClarifications" } },
        "PATCH",
        owner,
      ),
      { params: { id: created.id } },
    );
    // submit triggers PROPOSING_COMPONENTS → auto-advance → REVIEWING_COMPONENTS.
    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        { event: { type: "acceptComponents" } },
        "PATCH",
        owner,
      ),
      { params: { id: created.id } },
    );
    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        {
          event: {
            type: "setThreshold",
            threshold: 100,
            thresholdLabel: "high",
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id: created.id } },
    );
    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.stateKind).toBe("RESEARCHING");
    return created.id;
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  test("startResearch with llm_prior fires the adapter and transitions to REVIEWING_RESEARCH (1-component)", async () => {
    const id = await setupResearchingConversation();
    mockLlmPrior.mockResolvedValueOnce({
      bundle: bundle("c1", "llm_prior") as never,
      model: "test-model",
      latencyMs: 1,
      costUsd: 0.01,
      retryCount: 0,
    } as never);

    const response = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${id}`,
        {
          event: {
            type: "startResearch",
            componentId: "c1",
            mechanism: "llm_prior",
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id } },
    );
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      state: { kind: string; bundles?: Record<string, unknown> };
    };
    expect(body.state.kind).toBe("REVIEWING_RESEARCH");
    expect(body.state.bundles?.c1).toBeDefined();

    expect(mockLlmPrior).toHaveBeenCalledTimes(1);
    expect(mockLlmPrior.mock.calls[0][0].component.id).toBe("c1");

    // Persisted state matches the response.
    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.stateKind).toBe("REVIEWING_RESEARCH");
  });

  test("startResearch with expert_panel + estimates dispatches the synchronous adapter", async () => {
    const id = await setupResearchingConversation();
    mockExpertPanel.mockReturnValueOnce({
      bundle: bundle("c1", "expert_panel") as never,
      rawStatistics: {
        n: 3,
        mean: 50,
        sd: 10,
        min: 40,
        max: 60,
        median: 50,
      },
    } as never);

    const response = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${id}`,
        {
          event: {
            type: "startResearch",
            componentId: "c1",
            mechanism: "expert_panel",
            inputs: {
              estimates: [40, 50, 60],
              labels: ["a", "b", "c"],
              distribution: "normal",
            },
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id } },
    );
    expect(response.status).toBe(200);
    expect(mockExpertPanel).toHaveBeenCalledTimes(1);
    const args = mockExpertPanel.mock.calls[0][0];
    expect(args.estimates).toEqual([40, 50, 60]);
    expect(args.labels).toEqual(["a", "b", "c"]);
    expect(args.distribution).toBe("normal");
  });

  test("startResearch with web_search but no Tavily key produces ERROR via fail event", async () => {
    const id = await setupResearchingConversation();
    // Ensure no Tavily key in env for this test.
    const originalKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;

    try {
      const response = await semanticIdRoute.PATCH(
        makeRequest(
          `/api/semantic/${id}`,
          {
            event: {
              type: "startResearch",
              componentId: "c1",
              mechanism: "web_search",
            },
          },
          "PATCH",
          owner,
        ),
        { params: { id } },
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as {
        state: { kind: string; message?: string };
      };
      expect(body.state.kind).toBe("ERROR");
      expect(body.state.message).toMatch(/TAVILY_API_KEY/i);
      expect(mockWeb).not.toHaveBeenCalled();
    } finally {
      if (originalKey !== undefined) process.env.TAVILY_API_KEY = originalKey;
    }
  });

  test("startResearch with malformed inputs (estimates with NaN) is rejected at the validator (400)", async () => {
    const id = await setupResearchingConversation();
    const response = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${id}`,
        {
          event: {
            type: "startResearch",
            componentId: "c1",
            mechanism: "expert_panel",
            inputs: { estimates: [NaN, 2] },
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id } },
    );
    // JSON.stringify converts NaN to null, so the validator sees null and
    // rejects with VALIDATION_ERROR. This is the contract we want.
    expect(response.status).toBe(400);
    expect(mockExpertPanel).not.toHaveBeenCalled();
  });

  test("startResearch with an unknown mechanism is rejected at the validator (400)", async () => {
    const id = await setupResearchingConversation();
    const response = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${id}`,
        {
          event: {
            type: "startResearch",
            componentId: "c1",
            mechanism: "magic",
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id } },
    );
    expect(response.status).toBe(400);
  });

  test("startResearch with unexpected inputs key is rejected (400, audit clean)", async () => {
    const id = await setupResearchingConversation();
    const response = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${id}`,
        {
          event: {
            type: "startResearch",
            componentId: "c1",
            mechanism: "llm_prior",
            inputs: { rogueField: "leak-me" },
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id } },
    );
    expect(response.status).toBe(400);
    expect(mockLlmPrior).not.toHaveBeenCalled();
  });

  test("audit metadata for a startResearch dispatch contains mechanism + componentId but NOT the inputs payload", async () => {
    const id = await setupResearchingConversation();
    mockExpertPanel.mockReturnValueOnce({
      bundle: bundle("c1", "expert_panel") as never,
      rawStatistics: {
        n: 2,
        mean: 1,
        sd: 1,
        min: 0,
        max: 2,
        median: 1,
      },
    } as never);

    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${id}`,
        {
          event: {
            type: "startResearch",
            componentId: "c1",
            mechanism: "expert_panel",
            inputs: {
              estimates: [12345.6789, 98765.4321],
              labels: ["VERY_PRIVATE_LABEL"],
            },
          },
        },
        "PATCH",
        owner,
      ),
      { params: { id } },
    );

    const events = await prisma.auditEvent.findMany({
      where: { eventType: "semantic.event_applied" },
    });
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    const blob = last.metadataJson ?? "";
    // The mechanism + componentId are allowed for downstream audit.
    expect(blob).toContain("expert_panel");
    expect(blob).toContain("c1");
    // The inputs payload must NOT leak.
    expect(blob).not.toContain("12345.6789");
    expect(blob).not.toContain("98765.4321");
    expect(blob).not.toContain("VERY_PRIVATE_LABEL");
  });
});
