import { NextRequest } from "next/server";
import { POST } from "@/app/api/analyze/route";
import { isPathAEnabled } from "@/lib/feature-flags";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("LEGACY_PATH_A_ENABLED flag", () => {
  const originalFlag = process.env.LEGACY_PATH_A_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.LEGACY_PATH_A_ENABLED;
    } else {
      process.env.LEGACY_PATH_A_ENABLED = originalFlag;
    }
  });

  describe("isPathAEnabled", () => {
    test("defaults to enabled when env var is unset (local dev posture)", () => {
      expect(isPathAEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    });

    test("enabled when set to 'true'", () => {
      expect(isPathAEnabled({ LEGACY_PATH_A_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    });

    test("enabled when set to 'TRUE' (case-insensitive)", () => {
      expect(isPathAEnabled({ LEGACY_PATH_A_ENABLED: "TRUE" } as NodeJS.ProcessEnv)).toBe(true);
    });

    test("disabled when set to 'false'", () => {
      expect(isPathAEnabled({ LEGACY_PATH_A_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    });

    test("disabled for any non-'true' value (fail safe)", () => {
      expect(isPathAEnabled({ LEGACY_PATH_A_ENABLED: "yes" } as NodeJS.ProcessEnv)).toBe(false);
      expect(isPathAEnabled({ LEGACY_PATH_A_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
      expect(isPathAEnabled({ LEGACY_PATH_A_ENABLED: "" } as NodeJS.ProcessEnv)).toBe(false);
    });
  });

  describe("POST /api/analyze gating", () => {
    test("returns 404 PATH_A_DISABLED when flag is false", async () => {
      process.env.LEGACY_PATH_A_ENABLED = "false";

      const response = await POST(makeRequest({ query: "anything", model: "openrouter/auto" }));
      const body = (await response.json()) as { error?: { code?: string; message?: string } };

      expect(response.status).toBe(404);
      expect(body.error?.code).toBe("PATH_A_DISABLED");
      expect(body.error?.message).toMatch(/disabled/i);
    });

    test("does NOT return 404 when flag is true (proceeds to validation/upstream)", async () => {
      process.env.LEGACY_PATH_A_ENABLED = "true";

      const response = await POST(makeRequest({}));
      expect(response.status).not.toBe(404);
    });

    test("does NOT return 404 when flag is unset (default-enabled local dev)", async () => {
      delete process.env.LEGACY_PATH_A_ENABLED;

      const response = await POST(makeRequest({}));
      expect(response.status).not.toBe(404);
    });
  });
});
