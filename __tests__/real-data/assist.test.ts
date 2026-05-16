import {
  parseRealDataInsight,
  validateRealDataAssistRequest,
} from "@/lib/real-data/assist";

describe("real-data assist", () => {
  test("validates assist request shape", () => {
    expect(
      validateRealDataAssistRequest({
        query: "Observed CSV",
        targetColumn: "outcome",
        rowCount: 4,
        missingCount: 0,
        mean: 0.75,
        median: 1,
        ciLow: 0.075,
        ciHigh: 1,
        pAboveThreshold: 0.75,
        threshold: 0.5,
        model: "example/model",
        apiKey: "sk-or-secret",
      })
    ).toMatchObject({
      query: "Observed CSV",
      targetColumn: "outcome",
      rowCount: 4,
      apiKey: "sk-or-secret",
    });
  });

  test("rejects impossible missingness", () => {
    expect(() =>
      validateRealDataAssistRequest({
        query: "Observed CSV",
        targetColumn: "outcome",
        rowCount: 4,
        missingCount: 5,
        mean: 0.75,
        median: 1,
        ciLow: 0.075,
        ciHigh: 1,
        pAboveThreshold: 0.75,
        threshold: 0.5,
        model: "example/model",
      })
    ).toThrow("missingCount cannot exceed rowCount");
  });

  test("parses fenced JSON insight", () => {
    expect(
      parseRealDataInsight(
        '```json\n{"summary":"Observed rate is 75%.","cautions":["Small n."],"nextChecks":["Inspect missing data."]}\n```'
      )
    ).toEqual({
      summary: "Observed rate is 75%.",
      cautions: ["Small n."],
      nextChecks: ["Inspect missing data."],
    });
  });
});
