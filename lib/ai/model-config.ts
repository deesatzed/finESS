export interface ModelOption {
  id: string;
  label: string;
}

export function labelFromModelId(id: string) {
  return (
    id
      .split("/")
      .pop()
      ?.replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) ?? id
  );
}

function normalizeModel(value: unknown): ModelOption | null {
  if (typeof value === "string") {
    const [idPart, labelPart] = value.split("|");
    const id = idPart.trim();
    if (!id) return null;
    return { id, label: labelPart?.trim() || labelFromModelId(id) };
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim() === "") return null;
    const id = record.id.trim();
    return {
      id,
      label:
        typeof record.label === "string" && record.label.trim() !== ""
          ? record.label.trim()
          : labelFromModelId(id),
    };
  }

  return null;
}

export function parseModelOptions(raw: string | undefined): ModelOption[] {
  if (!raw?.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map(normalizeModel)
        .filter((model): model is ModelOption => model !== null);
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return raw
    .split(",")
    .map(normalizeModel)
    .filter((model): model is ModelOption => model !== null);
}

export function getConfiguredModels(env: NodeJS.ProcessEnv = process.env) {
  const models = parseModelOptions(env.OPENROUTER_MODELS ?? env.AI_MODELS);
  const defaultModel =
    env.OPENROUTER_DEFAULT_MODEL?.trim() ||
    env.OPENROUTER_MODEL?.trim() ||
    models[0]?.id ||
    "";

  return {
    models:
      models.length > 0 || !defaultModel
        ? models
        : [{ id: defaultModel, label: labelFromModelId(defaultModel) }],
    defaultModel,
    hasEnvApiKey: Boolean(env.OPENROUTER_API_KEY?.trim()),
  };
}
