import { spawnSync } from "child_process";
import type { PrismaClient } from "@prisma/client";

const TEST_DATABASE_URL = "file:./audit.test.db";

describe("audit metadata redaction", () => {
  let prisma: PrismaClient;
  let recordAuditEvent: typeof import("@/lib/audit/events").recordAuditEvent;
  let FORBIDDEN_AUDIT_METADATA_KEYS: typeof import("@/lib/audit/events").FORBIDDEN_AUDIT_METADATA_KEYS;

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
    ({ recordAuditEvent, FORBIDDEN_AUDIT_METADATA_KEYS } = await import(
      "@/lib/audit/events"
    ));
  }, 30_000);

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  test.each(Array.from(["apiKey","api_key","OPENROUTER_API_KEY","authorization","cookie","sessionToken","session_token","rawRows","csvRows","rows","query","prompt","freeText"]))(
    "does not persist forbidden key %s",
    async (key) => {
      await recordAuditEvent({
        type: "real_data.assist",
        metadata: {
          [key]: "should-not-leak-XYZ",
          model: "openrouter/auto",
          rowCount: 4,
        },
      });

      const row = await prisma.auditEvent.findFirstOrThrow();
      expect(row.metadataJson).not.toBeNull();
      const stored = JSON.parse(row.metadataJson as string) as Record<
        string,
        unknown
      >;

      expect(stored).not.toHaveProperty(key);
      expect(JSON.stringify(stored)).not.toContain("should-not-leak-XYZ");
      expect(stored.model).toBe("openrouter/auto");
      expect(stored.rowCount).toBe(4);
    }
  );

  test("preserves allowed summary statistics", async () => {
    await recordAuditEvent({
      type: "real_data.assist",
      metadata: {
        model: "openrouter/auto",
        rowCount: 4,
        missingCount: 1,
        hasThreshold: true,
      },
    });

    const row = await prisma.auditEvent.findFirstOrThrow();
    const stored = JSON.parse(row.metadataJson as string) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      model: "openrouter/auto",
      rowCount: 4,
      missingCount: 1,
      hasThreshold: true,
    });
  });

  test("redacts forbidden keys nested inside objects", async () => {
    await recordAuditEvent({
      type: "real_data.assist",
      metadata: {
        model: "openrouter/auto",
        upstream: {
          apiKey: "sk-or-should-not-leak",
          status: 200,
        },
      },
    });

    const row = await prisma.auditEvent.findFirstOrThrow();
    expect(row.metadataJson).not.toContain("sk-or-should-not-leak");
    const stored = JSON.parse(row.metadataJson as string) as Record<
      string,
      unknown
    >;
    expect(stored.upstream).toEqual({ status: 200 });
  });

  test("FORBIDDEN_AUDIT_METADATA_KEYS is the single source of truth", () => {
    expect(FORBIDDEN_AUDIT_METADATA_KEYS.has("apiKey")).toBe(true);
    expect(FORBIDDEN_AUDIT_METADATA_KEYS.has("cookie")).toBe(true);
    expect(FORBIDDEN_AUDIT_METADATA_KEYS.has("rawRows")).toBe(true);
    expect(FORBIDDEN_AUDIT_METADATA_KEYS.has("query")).toBe(true);
    expect(FORBIDDEN_AUDIT_METADATA_KEYS.has("rowCount")).toBe(false);
  });
});
