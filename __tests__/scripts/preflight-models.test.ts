import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "../../scripts/preflight-models.mjs");

// IMPORTANT: The injected fetch implementation below is a TEST HARNESS FAKE,
// not product mock data. Per CLAUDE.md the no-mock rule bans mock/simulated
// PRODUCT data and cached responses; isolating the network boundary in a unit
// test so we can exercise both pass and fail branches deterministically without
// hitting the real OpenRouter endpoint is an explicitly allowed test pattern.
// All product code paths (parsing, exit codes, output strings) are exercised
// by the real script; only `fetch` is substituted.

interface CompletionResponse {
  status: number;
  body: string;
}

function makeHarness(
  cwd: string,
  responses: Record<string, CompletionResponse>
) {
  const dataPath = join(cwd, "__fetch_responses.json");
  writeFileSync(dataPath, JSON.stringify(responses));

  const harnessPath = join(cwd, "__harness.mjs");
  // The harness installs a global fetch that reads canned responses by model id
  // from the request body, then imports the real preflight script unchanged.
  writeFileSync(
    harnessPath,
    `
import { readFileSync } from "node:fs";
const responses = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, "utf8"));
globalThis.fetch = async (_url, init) => {
  const parsed = JSON.parse(init.body);
  const canned = responses[parsed.model];
  if (!canned) {
    return new Response(JSON.stringify({ error: "no-fake-for-" + parsed.model }), { status: 500 });
  }
  return new Response(canned.body, {
    status: canned.status,
    headers: { "content-type": "application/json" },
  });
};
await import(${JSON.stringify(SCRIPT)});
`
  );
  return harnessPath;
}

function makeTempProject(files: Record<string, string>) {
  const dir = join(tmpdir(), `finess-preflight-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function run(cwd: string, harness: string | null, env: NodeJS.ProcessEnv = {}) {
  const args = harness ? [harness] : [SCRIPT];
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("scripts/preflight-models.mjs", () => {
  afterEach(() => {
    for (const name of require("fs").readdirSync(tmpdir())) {
      if (name.startsWith("finess-preflight-")) {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  test("skips and exits 0 when API key is empty", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local":
        "OPENROUTER_API_KEY=\nOPENROUTER_MODELS=foo/bar,baz/qux\n",
    });

    const result = run(cwd, null, { OPENROUTER_API_KEY: "" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "PREFLIGHT_MODELS_SKIPPED: no API key configured"
    );
  });

  test("exits 0 when all models return content", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local":
        "OPENROUTER_API_KEY=test-key\nOPENROUTER_MODELS=foo/bar,baz/qux\n",
    });
    const harness = makeHarness(cwd, {
      "foo/bar": {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: "pong" } }],
        }),
      },
      "baz/qux": {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: "pong" } }],
        }),
      },
    });

    const result = run(cwd, harness);

    expect(result.stdout + result.stderr).toContain(
      "PREFLIGHT_MODELS_OK: 2 models verified (foo/bar,baz/qux)"
    );
    expect(result.status).toBe(0);
  });

  test("exits 1 when a model returns empty content", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local":
        "OPENROUTER_API_KEY=test-key\nOPENROUTER_MODELS=foo/bar,baz/qux\n",
    });
    const harness = makeHarness(cwd, {
      "foo/bar": {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: "pong" } }],
        }),
      },
      "baz/qux": {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: "" } }] }),
      },
    });

    const result = run(cwd, harness);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "PREFLIGHT_MODELS_FAILED: baz/qux (empty content and no tool_calls)"
    );
  });

  test("exits 1 when a model returns HTTP 500", () => {
    const cwd = makeTempProject({
      ".env": "DATABASE_URL=file:./dev.db\n",
      ".env.local":
        "OPENROUTER_API_KEY=test-key\nOPENROUTER_MODELS=foo/bar\n",
    });
    const harness = makeHarness(cwd, {
      "foo/bar": {
        status: 500,
        body: JSON.stringify({ error: "boom" }),
      },
    });

    const result = run(cwd, harness);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /PREFLIGHT_MODELS_FAILED: foo\/bar \(HTTP 500/
    );
  });
});
