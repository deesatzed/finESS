import { NextResponse } from "next/server";

interface ModelOption {
  id: string;
  label: string;
}

export const dynamic = "force-dynamic";

function labelFromId(id: string) {
  return id
    .split("/")
    .pop()
    ?.replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) ?? id;
}

function normalizeModel(value: unknown): ModelOption | null {
  if (typeof value === "string") {
    const [idPart, labelPart] = value.split("|");
    const id = idPart.trim();
    if (!id) return null;
    return { id, label: labelPart?.trim() || labelFromId(id) };
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim() === "") return null;
    return {
      id: record.id.trim(),
      label:
        typeof record.label === "string" && record.label.trim() !== ""
          ? record.label.trim()
          : labelFromId(record.id.trim()),
    };
  }

  return null;
}

function parseModels(raw: string | undefined): ModelOption[] {
  if (!raw?.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeModel).filter((m): m is ModelOption => m !== null);
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return raw
    .split(",")
    .map(normalizeModel)
    .filter((m): m is ModelOption => m !== null);
}

export async function GET() {
  const models = parseModels(
    process.env.OPENROUTER_MODELS ?? process.env.AI_MODELS
  );
  const defaultModel =
    process.env.OPENROUTER_DEFAULT_MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    models[0]?.id ||
    "";

  const finalModels =
    models.length > 0 || !defaultModel
      ? models
      : [{ id: defaultModel, label: labelFromId(defaultModel) }];

  return NextResponse.json({
    models: finalModels,
    defaultModel,
    hasApiKey: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
  });
}
