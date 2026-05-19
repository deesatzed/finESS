import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";

const TEST_DATABASE_URL = "file:./analyze-multi.test.db";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/analyze/multi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function graphChoiceBody(graphJson: string, cost = 0.001) {
  return {
    model: "test/echo",
    choices: [{ message: { content: graphJson } }],
    usage: { cost },
  };
}

describe("POST /api/analyze/multi (R6-02)", () => {
  let POST: typeof import("@/app/api/analyze/multi/route").POST;
  let resetRateLimit: typeof import("@/app/api/analyze/multi/test-hooks").resetRateLimit;
  let prisma: PrismaClient;
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFlag = process.env.LEGACY_PATH_A_ENABLED;
  const originalModels = process.env.OPENROUTER_MODELS;

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
    ({ POST } = await import("@/app/api/analyze/multi/route"));
    ({ resetRateLimit } = await import("@/app/api/analyze/multi/test-hooks"));
  }, 30_000);

  beforeEach(async () => {
    resetRateLimit();
    await prisma.auditEvent.deleteMany();
    process.env.OPENROUTER_API_KEY = "sk-test-default";
    process.env.LEGACY_PATH_A_ENABLED = "true";
    process.env.OPENROUTER_MODELS = "primary/test,secondary/test";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(async () => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalFlag === undefined) delete process.env.LEGACY_PATH_A_ENABLED;
    else process.env.LEGACY_PATH_A_ENABLED = originalFlag;
    if (originalModels === undefined) delete process.env.OPENROUTER_MODELS;
    else process.env.OPENROUTER_MODELS = originalModels;
    await prisma?.$disconnect();
  });

  test("returns proposals + summary for two configured models", async () => {
    // Fetch substitute (TEST-HARNESS FAKE — not product mock data; product
    // path still uses real OpenRouter).
    let call = 0;
    const fetchFake = jest.fn().mockImplementation(async () => {
      const idx = call++;
      const graph = JSON.parse(JSON.stringify(PE_EXAMPLE_GRAPH));
      // Mutate ids so the two proposers' graphs visibly differ.
      const oldId = graph.nodes[0].id;
      const newId = idx === 0 ? "first_node_x" : "first_node_y";
      graph.nodes[0].id = newId;
      for (const e of graph.edges) {
        if (e.source === oldId) e.source = newId;
        if (e.target === oldId) e.target = newId;
      }
      if (graph.outputNodeId === oldId) graph.outputNodeId = newId;
      return jsonResponse(graphChoiceBody(JSON.stringify(graph), 0.0008));
    });
    global.fetch = fetchFake as unknown as typeof fetch;

    const response = await POST(
      makeRequest({ query: "Patient with chest pain — assess PE" })
    );
    const body = await readJson(response);

    expect(response.status).toBe(200);
    const proposals = body.proposals as Array<{
      model: string;
      graph?: { nodes: Array<{ id: string }> };
      error?: string;
    }>;
    expect(proposals).toHaveLength(2);
    expect(proposals[0].model).toBe("primary/test");
    expect(proposals[1].model).toBe("secondary/test");
    expect(proposals[0].graph?.nodes[0].id).toBe("first_node_x");
    expect(proposals[1].graph?.nodes[0].id).toBe("first_node_y");

    const summary = body.summary as { successCount: number; errorCount: number };
    expect(summary.successCount).toBe(2);
    expect(summary.errorCount).toBe(0);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "analyze_multi_proposed" },
    });
    expect(audit.metadataJson).toContain('"proposerCount":2');
    expect(audit.metadataJson).toContain('"successCount":2');
  });

  test("isolates a failing proposer in the response", async () => {
    let call = 0;
    const fetchFake = jest.fn().mockImplementation(async () => {
      const idx = call++;
      if (idx === 0) {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }
      return jsonResponse(graphChoiceBody(JSON.stringify(PE_EXAMPLE_GRAPH), 0.001));
    });
    global.fetch = fetchFake as unknown as typeof fetch;

    const response = await POST(makeRequest({ query: "mixed outcome" }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    const proposals = body.proposals as Array<{ error?: string; graph?: unknown }>;
    expect(proposals).toHaveLength(2);
    expect(proposals[0].error).toMatch(/HTTP/);
    expect(proposals[0].graph).toBeUndefined();
    expect(proposals[1].graph).toBeDefined();

    const summary = body.summary as { successCount: number; errorCount: number };
    expect(summary.successCount).toBe(1);
    expect(summary.errorCount).toBe(1);
  });

  test("returns 404 PATH_A_DISABLED when flag is off", async () => {
    process.env.LEGACY_PATH_A_ENABLED = "false";
    const response = await POST(makeRequest({ query: "anything" }));
    const body = await readJson(response);
    expect(response.status).toBe(404);
    expect(((body.error ?? {}) as { code?: string }).code).toBe("PATH_A_DISABLED");
  });

  test("rejects empty query with 400 VALIDATION_ERROR", async () => {
    const response = await POST(makeRequest({ query: "" }));
    const body = await readJson(response);
    expect(response.status).toBe(400);
    expect(((body.error ?? {}) as { code?: string }).code).toBe("VALIDATION_ERROR");
  });

  test("requires an API key (or session key)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const response = await POST(makeRequest({ query: "key check" }));
    const body = await readJson(response);
    expect(response.status).toBe(500);
    expect(((body.error ?? {}) as { code?: string }).code).toBe("MISSING_API_KEY");
  });

  test("uses session apiKey and does not echo it in audit metadata", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(graphChoiceBody(JSON.stringify(PE_EXAMPLE_GRAPH), 0.001)));
    global.fetch = fetchFake as unknown as typeof fetch;

    const response = await POST(
      makeRequest({ query: "session key test", apiKey: "sk-or-runtime-secret" })
    );
    expect(response.status).toBe(200);
    expect(fetchFake.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-runtime-secret",
        }),
      })
    );
    const responseJson = JSON.stringify(await readJson(response));
    expect(responseJson).not.toContain("sk-or-runtime-secret");

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "analyze_multi_proposed" },
    });
    expect(audit.metadataJson ?? "").not.toContain("sk-or-runtime-secret");
  });

  test("enforces rate limiting after MAX requests in a window", async () => {
    const fetchFake = jest
      .fn()
      .mockResolvedValue(jsonResponse(graphChoiceBody(JSON.stringify(PE_EXAMPLE_GRAPH), 0.0005)));
    global.fetch = fetchFake as unknown as typeof fetch;

    // 5 requests allowed, 6th should be rate-limited.
    for (let i = 0; i < 5; i++) {
      const ok = await POST(makeRequest({ query: `q${i}` }));
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(makeRequest({ query: "q-extra" }));
    expect(blocked.status).toBe(429);
  });
});
