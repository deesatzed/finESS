/**
 * Integration tests for the Semantic Mode API surface (Phase A2).
 *
 * Uses the same Prisma TEST_DATABASE_URL pattern as
 * __tests__/api/routes.test.ts. The test harness pushes the live schema
 * via `prisma db push --skip-generate` so the SemanticConversation table
 * is created from the canonical schema (not a hand-rolled fixture).
 *
 * Covers:
 *  - POST creates a conversation in CLARIFYING with the query verbatim
 *  - GET lists only the requester's conversations (cross-user isolation)
 *  - GET [id] loads an owned conversation
 *  - GET [id] returns 404 for cross-user attempts (no existence leak)
 *  - PATCH applies a valid event and persists the new state
 *  - PATCH returns 422 when the event is illegal in the current state
 *  - PATCH returns 400 when the event body is malformed
 *  - PATCH returns 401 unauthenticated, 404 for cross-user
 *  - DELETE removes the row; subsequent GET returns 404
 *  - DELETE returns 404 for cross-user attempts
 *  - Every route returns 401 unauthenticated
 *  - Audit events emit no forbidden metadata
 */

import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import type { LocalAuthSession } from "@/lib/auth/local-session";

const TEST_DATABASE_URL = "file:./semantic-api.test.db";

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

describe("Semantic API routes", () => {
  let prisma: PrismaClient;
  let semanticRoute: typeof import("@/app/api/semantic/route");
  let semanticIdRoute: typeof import("@/app/api/semantic/[id]/route");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let ownerA: LocalAuthSession;
  let ownerB: LocalAuthSession;

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
    semanticRoute = await import("@/app/api/semantic/route");
    semanticIdRoute = await import("@/app/api/semantic/[id]/route");
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));
  }, 30_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.semanticConversation.deleteMany();
    await prisma.calibrationOutcome.deleteMany();
    await prisma.analysis.deleteMany();
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    ownerA = await createLocalAuthSession("owner-a");
    ownerB = await createLocalAuthSession("owner-b");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("POST creates a conversation already advanced to CLARIFYING", async () => {
    const response = await semanticRoute.POST(
      makeRequest(
        "/api/semantic",
        { query: "What is the risk of PE here?" },
        "POST",
        ownerA,
      ),
    );
    const body = await readJson(response);

    expect(response.status).toBe(201);
    expect(typeof body.id).toBe("string");
    expect(body.userId).toBe(ownerA.userId);
    expect(body.workspaceId).toBe(ownerA.workspaceId);
    expect(body.query).toBe("What is the risk of PE here?");
    const state = body.state as { kind: string; query?: string };
    expect(state.kind).toBe("CLARIFYING");
    expect(state.query).toBe("What is the risk of PE here?");

    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.userId).toBe(ownerA.userId);
    expect(row.workspaceId).toBe(ownerA.workspaceId);
    expect(row.stateKind).toBe("CLARIFYING");
  });

  test("POST rejects empty or oversize queries with 400", async () => {
    const empty = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "   " }, "POST", ownerA),
    );
    expect(empty.status).toBe(400);
    expect((await readJson(empty)).error).toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const huge = await semanticRoute.POST(
      makeRequest(
        "/api/semantic",
        { query: "x".repeat(20_001) },
        "POST",
        ownerA,
      ),
    );
    expect(huge.status).toBe(400);

    const missing = await semanticRoute.POST(
      makeRequest("/api/semantic", {}, "POST", ownerA),
    );
    expect(missing.status).toBe(400);

    expect(await prisma.semanticConversation.count()).toBe(0);
  });

  test("GET scopes listing to the requester's workspace", async () => {
    // Owner A creates two conversations; owner B creates one.
    for (const q of ["Q1 for A", "Q2 for A"]) {
      const r = await semanticRoute.POST(
        makeRequest("/api/semantic", { query: q }, "POST", ownerA),
      );
      expect(r.status).toBe(201);
    }
    const r = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Q1 for B" }, "POST", ownerB),
    );
    expect(r.status).toBe(201);

    const listA = await semanticRoute.GET(
      makeRequest("/api/semantic", undefined, "GET", ownerA),
    );
    const bodyA = await readJson(listA);
    expect(listA.status).toBe(200);
    const aConversations = bodyA.conversations as Array<{
      userId: string;
      query: string;
    }>;
    expect(aConversations).toHaveLength(2);
    aConversations.forEach((c) => {
      expect(c.userId).toBe(ownerA.userId);
    });

    const listB = await semanticRoute.GET(
      makeRequest("/api/semantic", undefined, "GET", ownerB),
    );
    const bodyB = await readJson(listB);
    expect(listB.status).toBe(200);
    expect(bodyB.conversations as unknown[]).toHaveLength(1);
  });

  test("GET [id] loads a conversation owned by the requester", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Owned by A" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const load = await semanticIdRoute.GET(
      makeRequest(`/api/semantic/${created.id}`, undefined, "GET", ownerA),
      { params: { id: created.id as string } },
    );
    const loaded = await readJson(load);

    expect(load.status).toBe(200);
    expect(loaded.id).toBe(created.id);
    expect(loaded.query).toBe("Owned by A");
    expect((loaded.state as { kind: string }).kind).toBe("CLARIFYING");
  });

  test("GET [id] returns 404 (not 403) when owned by another user", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "A-private" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const crossLoad = await semanticIdRoute.GET(
      makeRequest(`/api/semantic/${created.id}`, undefined, "GET", ownerB),
      { params: { id: created.id as string } },
    );
    const body = await readJson(crossLoad);
    expect(crossLoad.status).toBe(404);
    expect(body.error).toMatchObject({ code: "NOT_FOUND" });

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: {
        eventType: "semantic.access_denied",
        userId: ownerB.userId,
      },
    });
    expect(audit.metadataJson).toContain("not_found_or_cross_owner");
  });

  test("PATCH applies a valid event and persists the new state", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "PE risk?" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const patch = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        {
          event: {
            type: "clarificationsReceived",
            questions: [
              { id: "q1", question: "Risk factors?", why: "Wells score" },
              { id: "q2", question: "D-dimer?" },
            ],
          },
        },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );
    const body = await readJson(patch);

    expect(patch.status).toBe(200);
    const state = body.state as {
      kind: string;
      questions: Array<{ id: string }>;
      answers: Record<string, string>;
    };
    expect(state.kind).toBe("AWAITING_ANSWERS");
    expect(state.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(state.answers).toEqual({});

    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.stateKind).toBe("AWAITING_ANSWERS");

    const applied = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "semantic.event_applied" },
    });
    expect(applied.metadataJson).toContain("AWAITING_ANSWERS");
    expect(applied.metadataJson).toContain("CLARIFYING");
    // The event payload (questions text) must NOT have been audited.
    expect(applied.metadataJson).not.toContain("Risk factors?");
    expect(applied.metadataJson).not.toContain("D-dimer?");
    expect(applied.metadataJson).not.toContain("Wells score");
  });

  test("PATCH returns 422 when the event is illegal in the current state", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Q" }, "POST", ownerA),
    );
    const created = await readJson(create);

    // CLARIFYING + acceptComponents is invalid — the reducer should throw.
    const patch = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        { event: { type: "acceptComponents" } },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );
    const body = await readJson(patch);

    expect(patch.status).toBe(422);
    expect(body.error).toMatchObject({ code: "UNPROCESSABLE_ENTITY" });

    // The persisted state must be UNCHANGED.
    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.stateKind).toBe("CLARIFYING");

    const rejected = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "semantic.event_rejected" },
    });
    expect(rejected.metadataJson).toContain("CLARIFYING");
    expect(rejected.metadataJson).toContain("state_error");
  });

  test("PATCH returns 400 on a malformed event body", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Q" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const missingEvent = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        { notAnEvent: true },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );
    expect(missingEvent.status).toBe(400);
    expect((await readJson(missingEvent)).error).toMatchObject({
      code: "VALIDATION_ERROR",
    });

    const unknownType = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        { event: { type: "noSuchEvent" } },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );
    expect(unknownType.status).toBe(400);

    const extraField = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        {
          event: {
            type: "start",
            query: "x",
            extra: "should-be-rejected",
          },
        },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );
    expect(extraField.status).toBe(400);

    // Persisted state must remain CLARIFYING.
    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.stateKind).toBe("CLARIFYING");
  });

  test("PATCH returns 404 on cross-user attempts", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "A-only" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const cross = await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        {
          event: {
            type: "clarificationsReceived",
            questions: [{ id: "q1", question: "?" }],
          },
        },
        "PATCH",
        ownerB,
      ),
      { params: { id: created.id as string } },
    );
    expect(cross.status).toBe(404);

    const row = await prisma.semanticConversation.findFirstOrThrow();
    expect(row.stateKind).toBe("CLARIFYING");
  });

  test("DELETE removes a conversation; subsequent GET returns 404", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Q" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const del = await semanticIdRoute.DELETE(
      makeRequest(`/api/semantic/${created.id}`, undefined, "DELETE", ownerA),
      { params: { id: created.id as string } },
    );
    expect(del.status).toBe(200);
    expect(await prisma.semanticConversation.count()).toBe(0);

    const load = await semanticIdRoute.GET(
      makeRequest(`/api/semantic/${created.id}`, undefined, "GET", ownerA),
      { params: { id: created.id as string } },
    );
    expect(load.status).toBe(404);
  });

  test("DELETE returns 404 for cross-user attempts (no 403, no leak)", async () => {
    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Q" }, "POST", ownerA),
    );
    const created = await readJson(create);

    const del = await semanticIdRoute.DELETE(
      makeRequest(`/api/semantic/${created.id}`, undefined, "DELETE", ownerB),
      { params: { id: created.id as string } },
    );
    expect(del.status).toBe(404);
    expect((await readJson(del)).error).toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.semanticConversation.count()).toBe(1);
  });

  test("every route returns 401 when unauthenticated", async () => {
    const list = await semanticRoute.GET(
      makeRequest("/api/semantic", undefined, "GET"),
    );
    expect(list.status).toBe(401);

    const create = await semanticRoute.POST(
      makeRequest("/api/semantic", { query: "Q" }),
    );
    expect(create.status).toBe(401);

    const load = await semanticIdRoute.GET(
      makeRequest("/api/semantic/missing", undefined, "GET"),
      { params: { id: "missing" } },
    );
    expect(load.status).toBe(401);

    const patch = await semanticIdRoute.PATCH(
      makeRequest(
        "/api/semantic/missing",
        { event: { type: "submitClarifications" } },
        "PATCH",
      ),
      { params: { id: "missing" } },
    );
    expect(patch.status).toBe(401);

    const del = await semanticIdRoute.DELETE(
      makeRequest("/api/semantic/missing", undefined, "DELETE"),
      { params: { id: "missing" } },
    );
    expect(del.status).toBe(401);

    expect(
      await prisma.auditEvent.count({
        where: { eventType: "semantic.access_denied" },
      }),
    ).toBe(5);
  });

  test("audit metadata never carries forbidden keys for any semantic event type", async () => {
    // Drive the full set of new semantic.* event types through a real
    // request flow and assert that NONE of the persisted metadata blobs
    // contain a forbidden key. Mirrors the audit/events.test.ts pattern
    // for the new event types specifically.
    const SENSITIVE_QUERY = "secret-string-NEVER-LEAK";

    // semantic.created
    const create = await semanticRoute.POST(
      makeRequest(
        "/api/semantic",
        { query: SENSITIVE_QUERY },
        "POST",
        ownerA,
      ),
    );
    const created = await readJson(create);

    // semantic.listed
    await semanticRoute.GET(makeRequest("/api/semantic", undefined, "GET", ownerA));

    // semantic.loaded
    await semanticIdRoute.GET(
      makeRequest(`/api/semantic/${created.id}`, undefined, "GET", ownerA),
      { params: { id: created.id as string } },
    );

    // semantic.event_applied
    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        {
          event: {
            type: "clarificationsReceived",
            questions: [{ id: "q1", question: SENSITIVE_QUERY }],
          },
        },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );

    // semantic.event_rejected — illegal transition
    await semanticIdRoute.PATCH(
      makeRequest(
        `/api/semantic/${created.id}`,
        { event: { type: "acceptComponents" } },
        "PATCH",
        ownerA,
      ),
      { params: { id: created.id as string } },
    );

    // semantic.access_denied
    await semanticIdRoute.GET(
      makeRequest(`/api/semantic/${created.id}`, undefined, "GET", ownerB),
      { params: { id: created.id as string } },
    );

    // semantic.deleted
    await semanticIdRoute.DELETE(
      makeRequest(`/api/semantic/${created.id}`, undefined, "DELETE", ownerA),
      { params: { id: created.id as string } },
    );

    const events = await prisma.auditEvent.findMany({
      where: {
        eventType: {
          in: [
            "semantic.created",
            "semantic.listed",
            "semantic.loaded",
            "semantic.event_applied",
            "semantic.event_rejected",
            "semantic.deleted",
            "semantic.access_denied",
          ],
        },
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(7);

    for (const event of events) {
      const blob = event.metadataJson ?? "";
      // No forbidden key names.
      expect(blob).not.toMatch(/"query"/);
      expect(blob).not.toMatch(/"prompt"/);
      expect(blob).not.toMatch(/"apiKey"/);
      expect(blob).not.toMatch(/"api_key"/);
      expect(blob).not.toMatch(/"freeText"/);
      expect(blob).not.toMatch(/"rawRows"/);
      // The sensitive query text must not have leaked anywhere.
      expect(blob).not.toContain(SENSITIVE_QUERY);
    }
  });
});
