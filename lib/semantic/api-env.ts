export function envProviderCallsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV !== "test" || env.RUN_OPENROUTER_LIVE === "1";
}

export function getEnvOpenRouterApiKey(
  env: NodeJS.ProcessEnv = process.env,
) {
  const key = env.OPENROUTER_API_KEY?.trim() || undefined;
  if (envProviderCallsEnabled(env)) return key;
  if (key?.startsWith("test-") || key?.startsWith("sk-test-")) return key;
  return undefined;
}

export function getEnvTavilyApiKey(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "test" && env.RUN_TAVILY_LIVE !== "1") {
    return undefined;
  }
  return env.TAVILY_API_KEY?.trim() || undefined;
}
