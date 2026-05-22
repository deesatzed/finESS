import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "../../scripts/check-env.mjs");

function makeTempProject(files: Record<string, string>) {
  const dir = join(tmpdir(), `finess-env-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function runCheck(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: "utf8",
  });
}

describe("scripts/check-env.mjs", () => {
  afterEach(() => {
    // Test temp dirs live under the OS temp directory and are safe to remove by prefix.
    for (const name of require("fs").readdirSync(tmpdir())) {
      if (name.startsWith("finess-env-")) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  test("rejects an empty DATABASE_URL in .env.local", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local": "OPENROUTER_API_KEY=\nDATABASE_URL=\n",
    });

    const result = runCheck(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      ".env.local contains an empty DATABASE_URL"
    );
  });

  test("allows .env.local without DATABASE_URL", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local": "OPENROUTER_API_KEY=\n",
    });

    const result = runCheck(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Environment preflight passed");
  });

  test("allows a non-empty DATABASE_URL in .env.local", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local": "DATABASE_URL=file:./alternate.db\n",
    });

    const result = runCheck(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Environment preflight passed");
  });

  test("normalizes quoted env values before validating booleans", () => {
    const cwd = makeTempProject({
      ".env": 'DATABASE_URL="file:./dev.db"\nLEGACY_PATH_A_ENABLED="true"\n',
    });

    const result = runCheck(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Environment preflight passed");
  });
});
