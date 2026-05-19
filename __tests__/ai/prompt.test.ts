import {
  PROMPT_EXAMPLES,
  buildSystemPrompt,
  buildUserMessage,
  scoreExample,
  selectExample,
} from "@/lib/ai/prompt";
import { parseAIResponse } from "@/lib/ai/parse-response";

describe("PROMPT_EXAMPLES", () => {
  test("includes the three configured domain examples", () => {
    const domains = PROMPT_EXAMPLES.map((e) => e.domain).sort();
    expect(domains).toEqual([
      "business-runway",
      "climate-risk",
      "medical-diagnostic",
    ]);
  });

  test("every example response parses cleanly through parseAIResponse", () => {
    for (const example of PROMPT_EXAMPLES) {
      const json = JSON.stringify(example.response);
      expect(() => parseAIResponse(json)).not.toThrow();
    }
  });

  test("every example has a non-empty keywords array", () => {
    for (const example of PROMPT_EXAMPLES) {
      expect(example.keywords.length).toBeGreaterThan(5);
    }
  });
});

describe("scoreExample", () => {
  const medical = PROMPT_EXAMPLES.find((e) => e.domain === "medical-diagnostic")!;
  const business = PROMPT_EXAMPLES.find((e) => e.domain === "business-runway")!;
  const climate = PROMPT_EXAMPLES.find((e) => e.domain === "climate-risk")!;

  test("returns zero when query has no overlapping keywords", () => {
    expect(scoreExample("what is the meaning of life", medical)).toBe(0);
    expect(scoreExample("what is the meaning of life", business)).toBe(0);
    expect(scoreExample("what is the meaning of life", climate)).toBe(0);
  });

  test("scores medical query against medical example highest", () => {
    const q = "patient with chest pain and high d-dimer, risk of pulmonary embolism";
    expect(scoreExample(q, medical)).toBeGreaterThan(scoreExample(q, business));
    expect(scoreExample(q, medical)).toBeGreaterThan(scoreExample(q, climate));
  });

  test("scores business query against business example highest", () => {
    const q = "startup runway with 12% MRR growth, chance of hitting $1M ARR before next raise";
    expect(scoreExample(q, business)).toBeGreaterThan(scoreExample(q, medical));
    expect(scoreExample(q, business)).toBeGreaterThan(scoreExample(q, climate));
  });

  test("scores climate query against climate example highest", () => {
    const q = "probability of major flood losses by 2035 under current carbon emission trajectories";
    expect(scoreExample(q, climate)).toBeGreaterThan(scoreExample(q, medical));
    expect(scoreExample(q, climate)).toBeGreaterThan(scoreExample(q, business));
  });
});

describe("selectExample", () => {
  test("returns null when no example matches", () => {
    expect(selectExample("what is the meaning of life")).toBeNull();
    expect(selectExample("")).toBeNull();
  });

  test("picks medical example for medical query", () => {
    const selected = selectExample(
      "patient with chest pain and elevated d-dimer, what's the risk of pulmonary embolism"
    );
    expect(selected?.domain).toBe("medical-diagnostic");
  });

  test("picks business example for startup query", () => {
    const selected = selectExample(
      "our SaaS startup has $40k MRR and 18 months runway, chance of $1M ARR before next raise"
    );
    expect(selected?.domain).toBe("business-runway");
  });

  test("picks climate example for climate-risk query", () => {
    const selected = selectExample(
      "probability of major flood losses to coastal property by 2035 under current emissions"
    );
    expect(selected?.domain).toBe("climate-risk");
  });
});

describe("buildSystemPrompt", () => {
  test("returns base prompt with no example when query has no domain match", () => {
    const prompt = buildSystemPrompt("what is the meaning of life");
    expect(prompt).not.toContain("## Worked Example");
    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("## Edge Methods");
    expect(prompt).toContain("## Critical Rules");
  });

  test("includes the medical example for a medical query", () => {
    const prompt = buildSystemPrompt(
      "patient diagnosis pulmonary embolism d-dimer sensitivity"
    );
    expect(prompt).toContain("## Worked Example");
    expect(prompt).toContain("pre_test_base");
    expect(prompt).not.toContain("current_mrr");
    expect(prompt).not.toContain("warming_pathway");
  });

  test("includes the business example for a startup query", () => {
    const prompt = buildSystemPrompt(
      "our SaaS startup MRR runway ARR growth churn"
    );
    expect(prompt).toContain("## Worked Example");
    expect(prompt).toContain("current_mrr");
    expect(prompt).not.toContain("pre_test_base");
    expect(prompt).not.toContain("warming_pathway");
  });

  test("includes the climate example for a climate-risk query", () => {
    const prompt = buildSystemPrompt(
      "climate emissions warming sea level flood loss"
    );
    expect(prompt).toContain("## Worked Example");
    expect(prompt).toContain("warming_pathway");
    expect(prompt).not.toContain("pre_test_base");
    expect(prompt).not.toContain("current_mrr");
  });

  test("does not bias non-medical queries toward the PE example", () => {
    const startupPrompt = buildSystemPrompt(
      "startup runway ARR growth churn next funding round"
    );
    expect(startupPrompt).not.toContain("pulmonary embolism");
    expect(startupPrompt).not.toContain("D-dimer");
  });
});

describe("buildUserMessage", () => {
  test("wraps the query with the canonical instruction prefix", () => {
    const msg = buildUserMessage("hello world");
    expect(msg).toContain("Analyze this decision problem");
    expect(msg).toContain("hello world");
  });
});
