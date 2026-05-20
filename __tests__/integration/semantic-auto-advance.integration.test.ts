/**
 * Live integration: full POST → CLARIFYING → server fires A3 adapter →
 * AWAITING_ANSWERS happens in one round trip. Verifies the auto-advance
 * wiring against real OpenRouter (gated by RUN_OPENROUTER_LIVE=1).
 */

import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import dotenv from "dotenv";
import type { PrismaClient } from "@prisma/client";
import type { LocalAuthSession } from "@/lib/auth/local-session";

// Load env BEFORE any module that reads it. Other live integration tests
// in this directory use the same pattern.
dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: false, quiet: true });

const TEST_DATABASE_URL = "file:./semantic-auto-advance.test.db";

function makeRequest(body: unknown, session: LocalAuthSession) {
  return new NextRequest("http://localhost/api/semantic", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `finess_local_session=${session.token}`,
    },
    body: JSON.stringify(body),
  });
}

const live = process.env.RUN_OPENROUTER_LIVE === "1";
const describeLive = live ? describe : describe.skip;

describeLive("semantic auto-advance live integration", () => {
  let prisma: PrismaClient;
  let semanticRoute: typeof import("@/app/api/semantic/route");
  let createLocalAuthSession: typeof import("@/lib/auth/local-session").createLocalAuthSession;
  let session: LocalAuthSession;

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
    ({ createLocalAuthSession } = await import("@/lib/auth/local-session"));
  }, 30_000);

  beforeEach(async () => {
    await prisma.semanticConversation.deleteMany();
    await prisma.auditEvent.deleteMany();
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    session = await createLocalAuthSession("e2e-auto-advance");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("POST returns AWAITING_ANSWERS with real LLM-produced questions", async () => {
    const response = await semanticRoute.POST(
      makeRequest(
        {
          query: "Will our coastal property portfolio see >$10M annual flood losses by 2035?",
        },
        session,
      ),
    );
    const body = (await response.json()) as {
      id: string;
      state: { kind: string; questions?: Array<{ id: string; question: string }> };
    };

    expect(response.status).toBe(201);
    expect(body.state.kind).toBe("AWAITING_ANSWERS");
    expect(Array.isArray(body.state.questions)).toBe(true);
    expect(body.state.questions!.length).toBeGreaterThanOrEqual(2);
    expect(body.state.questions!.length).toBeLessThanOrEqual(5);
    for (const q of body.state.questions!) {
      expect(typeof q.id).toBe("string");
      expect(q.id.length).toBeGreaterThan(0);
      expect(typeof q.question).toBe("string");
      expect(q.question.length).toBeGreaterThan(0);
    }

    console.log(
      `LIVE_AUTO_ADVANCE_OK: questions=${body.state.questions!.length} ids=[${body.state.questions!
        .map((q) => q.id)
        .join(",")}]`,
    );
  }, 60_000);
});
