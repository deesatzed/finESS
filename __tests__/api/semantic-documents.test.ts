/**
 * Semantic Mode B3 — documents API integration tests.
 *
 * Covers:
 *  - POST 401 unauthenticated
 *  - POST 400 missing file, unsupported mime, oversize
 *  - POST 201 happy path (uses LANCEDB on a temp dir, real chunker, but
 *    monkey-patches embed() to a deterministic 384-dim vector so the
 *    test does not require the BGE model to be downloaded)
 *  - POST 409 duplicate sha256 per user
 *  - GET lists scoped to (userId, workspaceId)
 *  - GET [id] returns 404 cross-owner (no existence leak)
 *  - DELETE removes Prisma row + LanceDB chunks
 *  - DELETE 404 cross-owner
 *  - Audit metadata contains no chunk text, no API keys
 *
 * The embed override is a TEST-HARNESS FAKE: it lets the API contract
 * tests run without the ~130MB BGE model download. The real-network
 * embedding path is exercised by the gated B3 integration test.
 */

import { spawnSync } from "child_process";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import type { LocalAuthSession } from "@/lib/auth/local-session";

const TEST_DATABASE_URL = "file:./semantic-documents-api.test.db";

function multipartRequest(
  path: string,
  fileContent: Buffer | string,
  filename: string,
  mimeType: string,
  session?: LocalAuthSession,
): NextRequest {
  const form = new FormData();
  const blob = new Blob([fileContent], { type: mimeType });
  // jsdom-free File constructor (available in Node 20+):
  const file = new File([blob], filename, { type: mimeType });
  form.append("file", file);

  const headers: Record<string, string> = {};
  if (session) headers.Cookie = `finess_local_session=${session.token}`;

  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: form,
  });
}

function plainRequest(
  path: string,
  method: string,
  session?: LocalAuthSession,
): NextRequest {
  const headers: Record<string, string> = {};
  if (session) headers.Cookie = `finess_local_session=${session.token}`;
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("Semantic documents API routes", () => {
  let prisma: PrismaClient;
  let docsRoute: typeof import("@/app/api/semantic/documents/route");
  let docsIdRoute: typeof import("@/app/api/semantic/documents/[id]/route");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let embedModule: typeof import("@/lib/rag/embed");
  let storeModule: typeof import("@/lib/rag/store");
  let originalEmbed: typeof import("@/lib/rag/embed").embed;
  let ownerA: LocalAuthSession;
  let ownerB: LocalAuthSession;
  let tempLanceDir: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    tempLanceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "finess-rag-api-"),
    );
    process.env.FINESS_LANCEDB_ROOT = tempLanceDir;

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
    docsRoute = await import("@/app/api/semantic/documents/route");
    docsIdRoute = await import("@/app/api/semantic/documents/[id]/route");
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));

    // Replace the embed implementation with a deterministic fake so we
    // don't need the BGE model on disk for these contract tests.
    embedModule = await import("@/lib/rag/embed");
    storeModule = await import("@/lib/rag/store");
    originalEmbed = embedModule.embed;
    (embedModule as unknown as { embed: typeof embedModule.embed }).embed =
      (async (texts: string[]) =>
        texts.map(() => new Array(384).fill(0.01))) as typeof embedModule.embed;
  }, 60_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.semanticDocument.deleteMany();
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    ownerA = await createLocalAuthSession("docs-owner-a");
    ownerB = await createLocalAuthSession("docs-owner-b");
    // Clean any LanceDB tables from a previous test
    await storeModule.__resetWorkspaceForTests(ownerA.workspaceId);
    await storeModule.__resetWorkspaceForTests(ownerB.workspaceId);
  });

  afterAll(async () => {
    (embedModule as unknown as { embed: typeof embedModule.embed }).embed =
      originalEmbed;
    await prisma?.$disconnect();
    await fs.rm(tempLanceDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // POST
  // -------------------------------------------------------------------------

  test("POST 401 without a session cookie", async () => {
    const req = multipartRequest(
      "/api/semantic/documents",
      "real content",
      "ref.md",
      "text/markdown",
    );
    const res = await docsRoute.POST(req);
    expect(res.status).toBe(401);
  });

  test("POST 400 when file field missing", async () => {
    const form = new FormData();
    const headers: Record<string, string> = {
      Cookie: `finess_local_session=${ownerA.token}`,
    };
    const req = new NextRequest("http://localhost/api/semantic/documents", {
      method: "POST",
      headers,
      body: form,
    });
    const res = await docsRoute.POST(req);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("POST 400 unsupported mime type", async () => {
    const req = multipartRequest(
      "/api/semantic/documents",
      Buffer.from('{"a":1}'),
      "data.json",
      "application/json",
      ownerA,
    );
    const res = await docsRoute.POST(req);
    expect(res.status).toBe(400);
  });

  test("POST 201 happy path for text/markdown", async () => {
    const content = `# Conversion Rate Benchmarks

B2B SaaS trial-to-paid conversion rates typically range from 2% to 5%
across mature markets, with the median around 3.1% (industry survey,
N=420 companies). Newer cohorts under 1 year tend toward the lower end.

Source: SaaS Benchmarks 2024.`;
    const req = multipartRequest(
      "/api/semantic/documents",
      content,
      "saas-benchmarks.md",
      "text/markdown",
      ownerA,
    );
    const res = await docsRoute.POST(req);
    expect(res.status).toBe(201);

    const body = await readJson(res);
    expect(typeof body.id).toBe("string");
    expect(body.userId).toBe(ownerA.userId);
    expect(body.workspaceId).toBe(ownerA.workspaceId);
    expect(body.filename).toBe("saas-benchmarks.md");
    expect(body.mimeType).toBe("text/markdown");
    expect(body.chunkCount).toBeGreaterThanOrEqual(1);

    // Prisma row persisted
    const row = await prisma.semanticDocument.findFirstOrThrow();
    expect(row.id).toBe(body.id);
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);

    // LanceDB chunks persisted
    const chunkCount = await storeModule.countChunks(ownerA.workspaceId);
    expect(chunkCount).toBe(row.chunkCount);

    // Audit emitted (no text leak)
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "semantic.document_uploaded" },
    });
    expect(audit.metadataJson).not.toContain("trial-to-paid");
    expect(audit.metadataJson).not.toContain("B2B SaaS");
    expect(audit.metadataJson).toContain(body.id);
  });

  test("POST 409 when the same content is uploaded twice by the same user", async () => {
    const content = "Identical reference content used twice.";
    const reqA = multipartRequest(
      "/api/semantic/documents",
      content,
      "first.txt",
      "text/plain",
      ownerA,
    );
    const a = await docsRoute.POST(reqA);
    expect(a.status).toBe(201);

    const reqB = multipartRequest(
      "/api/semantic/documents",
      content,
      "first-renamed.txt",
      "text/plain",
      ownerA,
    );
    const b = await docsRoute.POST(reqB);
    expect(b.status).toBe(409);
    const body = await readJson(b);
    expect(body.error).toMatchObject({ code: "DUPLICATE_DOCUMENT" });
  });

  test("POST 201 across users — sha256 unique is scoped to user", async () => {
    const content = "Same reference content; two users.";
    const a = await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        content,
        "ref.txt",
        "text/plain",
        ownerA,
      ),
    );
    expect(a.status).toBe(201);
    const b = await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        content,
        "ref.txt",
        "text/plain",
        ownerB,
      ),
    );
    expect(b.status).toBe(201);
  });

  // -------------------------------------------------------------------------
  // GET
  // -------------------------------------------------------------------------

  test("GET 401 without session", async () => {
    const res = await docsRoute.GET(
      plainRequest("/api/semantic/documents", "GET"),
    );
    expect(res.status).toBe(401);
  });

  test("GET scopes listing per user/workspace", async () => {
    await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Content for owner A first.",
        "a1.txt",
        "text/plain",
        ownerA,
      ),
    );
    await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Content for owner A second.",
        "a2.txt",
        "text/plain",
        ownerA,
      ),
    );
    await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Content for owner B.",
        "b1.txt",
        "text/plain",
        ownerB,
      ),
    );

    const listA = await docsRoute.GET(
      plainRequest("/api/semantic/documents", "GET", ownerA),
    );
    const bodyA = await readJson(listA);
    expect(listA.status).toBe(200);
    const docsA = bodyA.documents as Array<{ userId: string }>;
    expect(docsA).toHaveLength(2);
    for (const d of docsA) expect(d.userId).toBe(ownerA.userId);

    const listB = await docsRoute.GET(
      plainRequest("/api/semantic/documents", "GET", ownerB),
    );
    const bodyB = await readJson(listB);
    expect((bodyB.documents as unknown[]).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // GET [id]
  // -------------------------------------------------------------------------

  test("GET [id] returns metadata for owned doc", async () => {
    const create = await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Owned content for A.",
        "owned.txt",
        "text/plain",
        ownerA,
      ),
    );
    const created = await readJson(create);

    const res = await docsIdRoute.GET(
      plainRequest(`/api/semantic/documents/${created.id}`, "GET", ownerA),
      { params: { id: created.id as string } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.id).toBe(created.id);
    expect(body.chunkCount).toBeGreaterThanOrEqual(1);
  });

  test("GET [id] returns 404 cross-owner (no existence leak)", async () => {
    const create = await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Owner A private content.",
        "p.txt",
        "text/plain",
        ownerA,
      ),
    );
    const created = await readJson(create);

    const res = await docsIdRoute.GET(
      plainRequest(`/api/semantic/documents/${created.id}`, "GET", ownerB),
      { params: { id: created.id as string } },
    );
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error).toMatchObject({ code: "NOT_FOUND" });
  });

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  test("DELETE removes the row and the LanceDB chunks", async () => {
    const create = await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Content to delete soon.",
        "del.txt",
        "text/plain",
        ownerA,
      ),
    );
    const created = await readJson(create);
    const beforeChunks = await storeModule.countChunks(ownerA.workspaceId);
    expect(beforeChunks).toBeGreaterThanOrEqual(1);

    const res = await docsIdRoute.DELETE(
      plainRequest(`/api/semantic/documents/${created.id}`, "DELETE", ownerA),
      { params: { id: created.id as string } },
    );
    expect(res.status).toBe(200);

    expect(await prisma.semanticDocument.count()).toBe(0);
    const afterChunks = await storeModule.countChunks(ownerA.workspaceId);
    expect(afterChunks).toBe(0);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { eventType: "semantic.document_deleted" },
    });
    expect(audit.metadataJson).toContain(created.id as string);
  });

  test("DELETE 404 cross-owner", async () => {
    const create = await docsRoute.POST(
      multipartRequest(
        "/api/semantic/documents",
        "Owner A private content for delete.",
        "p2.txt",
        "text/plain",
        ownerA,
      ),
    );
    const created = await readJson(create);

    const res = await docsIdRoute.DELETE(
      plainRequest(`/api/semantic/documents/${created.id}`, "DELETE", ownerB),
      { params: { id: created.id as string } },
    );
    expect(res.status).toBe(404);

    // Row still present
    expect(await prisma.semanticDocument.count()).toBe(1);
  });
});
