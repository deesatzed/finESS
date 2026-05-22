import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cwd = process.cwd();
const defaultDatabaseUrl = "file:./dev.db";

function normalizeEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function readEnvFile(path) {
  if (!existsSync(path)) return new Map();

  const values = new Map();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;

    values.set(
      trimmed.slice(0, equalsAt).trim(),
      normalizeEnvValue(trimmed.slice(equalsAt + 1)),
    );
  }
  return values;
}

function ensureEnvFile(path, content) {
  if (!existsSync(path)) {
    writeFileSync(path, content);
    return "created";
  }
  return "present";
}

function ensureDatabaseUrl(path) {
  const values = readEnvFile(path);
  if (values.has("DATABASE_URL") && values.get("DATABASE_URL") !== "") {
    return "present";
  }

  appendFileSync(
    path,
    `${existsSync(path) ? "\n" : ""}DATABASE_URL=${defaultDatabaseUrl}\n`,
  );
  return values.has("DATABASE_URL") ? "filled" : "added";
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const envPath = join(cwd, ".env");
const localEnvPath = join(cwd, ".env.local");

const envStatus = ensureEnvFile(
  envPath,
  `# Local finESS database. Add API keys here only if you understand the local-only risk.\nDATABASE_URL=${defaultDatabaseUrl}\n`,
);
const localStatus = ensureEnvFile(
  localEnvPath,
  `# Local Next.js overrides. Keep secrets out of Git.\nDATABASE_URL=${defaultDatabaseUrl}\n`,
);
const envDbStatus = ensureDatabaseUrl(envPath);
const localDbStatus = ensureDatabaseUrl(localEnvPath);

console.log(`.env: ${envStatus}; DATABASE_URL ${envDbStatus}`);
console.log(`.env.local: ${localStatus}; DATABASE_URL ${localDbStatus}`);

run("npx", ["prisma", "generate"], { DATABASE_URL: defaultDatabaseUrl });
run("npx", ["prisma", "db", "push", "--skip-generate"], {
  DATABASE_URL: defaultDatabaseUrl,
});

console.log("Local setup complete");
