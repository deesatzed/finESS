import { NextResponse } from "next/server";
import { getConfiguredModels } from "@/lib/ai/model-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const { models, defaultModel, hasEnvApiKey } = getConfiguredModels();

  return NextResponse.json({
    models,
    defaultModel,
    hasApiKey: hasEnvApiKey,
  });
}
