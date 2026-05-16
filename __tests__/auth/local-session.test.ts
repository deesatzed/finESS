import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

const TEST_DATABASE_URL = "file:./auth.test.db";

function makeRequest() {
  return new NextRequest("http://localhost/api/auth/local", { method: "GET" });
}

function parseSetCookie(raw: string) {
  const parts = raw.split(";").map((s) => s.trim());
  const [nameValue, ...attrParts] = parts;
  const [name, value] = nameValue.split("=");
  const flags = new Set<string>();
  const attrs: Record<string, string> = {};
  for (const part of attrParts) {
    const [k, v] = part.split("=");
    const lk = k.toLowerCase();
    if (v === undefined) {
      flags.add(lk);
    } else {
      attrs[lk] = v;
    }
  }
  return { name, value, flags, attrs };
}

describe("local session cookie security", () => {
  let prisma: PrismaClient;
  let route: typeof import("@/app/api/auth/local/route");
  const originalNodeEnv = process.env.NODE_ENV;

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
    route = await import("@/app/api/auth/local/route");
  }, 30_000);

  beforeEach(async () => {
    await prisma.localSession.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
  });

  afterEach(() => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = originalNodeEnv;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test("development: cookie is HttpOnly, SameSite=Lax, NOT Secure", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
    const response = await route.GET(makeRequest());
    expect(response.status).toBe(201);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    const { name, value, flags, attrs } = parseSetCookie(setCookie as string);

    expect(name).toBe("finess_local_session");
    expect(value).toBeTruthy();
    expect(value.length).toBeGreaterThan(20);
    expect(flags.has("httponly")).toBe(true);
    expect(attrs["samesite"]?.toLowerCase()).toBe("lax");
    expect(flags.has("secure")).toBe(false);
    expect(attrs["path"]).toBe("/");
    expect(attrs["expires"] ?? attrs["max-age"]).toBeTruthy();
  });

  test("production: cookie carries the Secure flag", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    const response = await route.GET(makeRequest());
    expect(response.status).toBe(201);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    const { flags, attrs } = parseSetCookie(setCookie as string);

    expect(flags.has("httponly")).toBe(true);
    expect(attrs["samesite"]?.toLowerCase()).toBe("lax");
    expect(flags.has("secure")).toBe(true);
  });

  test("session token is not logged in the response body", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
    const response = await route.GET(makeRequest());
    const body = await response.json();
    const setCookie = response.headers.get("set-cookie");
    const { value } = parseSetCookie(setCookie as string);

    expect(JSON.stringify(body)).not.toContain(value);
    expect(body).toHaveProperty("userId");
    expect(body).toHaveProperty("workspaceId");
  });
});
