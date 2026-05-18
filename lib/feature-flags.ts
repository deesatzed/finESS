/**
 * Centralized feature-flag helpers. Pure functions only — no side effects,
 * no module-level state. Tests pass in a minimal env object so we don't
 * mutate process.env globally.
 */

export function isPathAEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LEGACY_PATH_A_ENABLED;
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() === "true";
}
