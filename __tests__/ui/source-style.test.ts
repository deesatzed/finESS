import { getSourceStyle } from "@/lib/ui/source-style";

describe("getSourceStyle", () => {
  test("literature is emerald with a citation-friendly tooltip", () => {
    const s = getSourceStyle("literature");
    expect(s.label).toBe("literature");
    expect(s.borderClass).toContain("emerald");
    expect(s.dotClass).toContain("emerald");
    expect(s.pillClass).toContain("emerald");
    expect(s.title).toMatch(/cited/i);
  });

  test("llm_prior is amber and warns about hallucination", () => {
    const s = getSourceStyle("llm_prior");
    expect(s.label).toBe("llm prior");
    expect(s.borderClass).toContain("amber");
    expect(s.dotClass).toContain("amber");
    expect(s.pillClass).toContain("amber");
    expect(s.title).toMatch(/draft|verify/i);
  });

  test("user_override is sky and names the operator", () => {
    const s = getSourceStyle("user_override");
    expect(s.label).toBe("user edit");
    expect(s.borderClass).toContain("sky");
    expect(s.dotClass).toContain("sky");
    expect(s.pillClass).toContain("sky");
    expect(s.title).toMatch(/operator/i);
  });

  test("undefined source defaults to llm_prior styling (conservative)", () => {
    expect(getSourceStyle(undefined)).toEqual(getSourceStyle("llm_prior"));
  });
});
