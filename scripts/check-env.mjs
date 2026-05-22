import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readEnvFile(path) {
  if (!existsSync(path)) return new Map();

  const values = new Map();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    const value = normalizeEnvValue(trimmed.slice(equalsAt + 1).trim());
    values.set(key, value);
  }
  return values;
}

function normalizeEnvValue(value) {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

const cwd = process.cwd();
const envPath = join(cwd, ".env");
const localEnvPath = join(cwd, ".env.local");
const env = readEnvFile(envPath);
const localEnv = readEnvFile(localEnvPath);

if (localEnv.has("DATABASE_URL") && localEnv.get("DATABASE_URL") === "") {
  console.error(
    ".env.local contains an empty DATABASE_URL. Remove that line or set a non-empty database URL so it does not override .env."
  );
  process.exit(1);
}

if (!env.has("DATABASE_URL") && !localEnv.has("DATABASE_URL")) {
  console.error(
    "DATABASE_URL is missing. Add DATABASE_URL=file:./dev.db to .env for local Prisma."
  );
  process.exit(1);
}

const pathAFlag =
  process.env.LEGACY_PATH_A_ENABLED ??
  localEnv.get("LEGACY_PATH_A_ENABLED") ??
  env.get("LEGACY_PATH_A_ENABLED");
if (pathAFlag !== undefined) {
  const normalized = pathAFlag.trim().toLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    console.error(
      `LEGACY_PATH_A_ENABLED must be exactly "true" or "false" (got "${pathAFlag}"). Path A is the LLM-drafts-the-graph route; keep "true" for local dev, "false" for hosted demos.`
    );
    process.exit(1);
  }
}

console.log("Environment preflight passed");
