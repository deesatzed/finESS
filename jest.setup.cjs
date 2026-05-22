const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

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

const root = process.cwd();
const env = readEnvFile(join(root, ".env"));
const localEnv = readEnvFile(join(root, ".env.local"));

for (const source of [env, localEnv]) {
  for (const [key, value] of source) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

process.env.DATABASE_URL ||= "file:./dev.db";
