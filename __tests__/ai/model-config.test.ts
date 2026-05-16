import { getConfiguredModels, parseModelOptions } from "@/lib/ai/model-config";

describe("model config", () => {
  test("parses comma-separated OpenRouter model options", () => {
    expect(
      parseModelOptions(
        "openai/gpt-4.1|GPT 4.1,anthropic/claude-sonnet-4|Claude Sonnet"
      )
    ).toEqual([
      { id: "openai/gpt-4.1", label: "GPT 4.1" },
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet" },
    ]);
  });

  test("parses JSON model options and derives labels", () => {
    expect(parseModelOptions('[{"id":"google/gemini-flash-1.5"}]')).toEqual([
      { id: "google/gemini-flash-1.5", label: "Gemini Flash 1.5" },
    ]);
  });

  test("uses default model as fallback option without exposing the API key", () => {
    expect(
      getConfiguredModels({
        OPENROUTER_DEFAULT_MODEL: "openai/gpt-4.1-mini",
        OPENROUTER_API_KEY: "sk-or-secret",
      })
    ).toEqual({
      models: [{ id: "openai/gpt-4.1-mini", label: "Gpt 4.1 Mini" }],
      defaultModel: "openai/gpt-4.1-mini",
      hasEnvApiKey: true,
    });
  });
});
