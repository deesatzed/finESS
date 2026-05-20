/**
 * Per-event-type validator coverage for `lib/validation/semantic.ts`.
 *
 * A2 shipped the validator at ~26% coverage because the API route tests
 * only exercised the happy path. This file walks every event type
 * through happy + rejection paths so the validator is honestly covered.
 */

import {
  validateSemanticCreateRequest,
  validateSemanticPatchRequest,
} from "@/lib/validation/semantic";
import { ValidationError } from "@/lib/validation/schemas";

function expectThrows(fn: () => unknown, pattern: RegExp): void {
  expect(() => fn()).toThrow(ValidationError);
  try {
    fn();
  } catch (err) {
    expect((err as Error).message).toMatch(pattern);
  }
}

describe("validateSemanticCreateRequest", () => {
  test("accepts a well-formed query", () => {
    const out = validateSemanticCreateRequest({ query: "Will our Q3 launch hit 10k?" });
    expect(out.query).toBe("Will our Q3 launch hit 10k?");
  });

  test("rejects non-object body", () => {
    expectThrows(() => validateSemanticCreateRequest(null), /Semantic create request/);
    expectThrows(() => validateSemanticCreateRequest("hi"), /Semantic create request/);
    expectThrows(() => validateSemanticCreateRequest([]), /Semantic create request/);
  });

  test("rejects missing query", () => {
    expectThrows(() => validateSemanticCreateRequest({}), /query is required/);
  });

  test("rejects non-string query", () => {
    expectThrows(() => validateSemanticCreateRequest({ query: 42 }), /query is required/);
  });

  test("rejects whitespace-only query", () => {
    expectThrows(() => validateSemanticCreateRequest({ query: "   " }), /non-empty/);
  });

  test("rejects query exceeding MAX_QUERY_LENGTH", () => {
    const huge = "x".repeat(20_001);
    expectThrows(() => validateSemanticCreateRequest({ query: huge }), /too large/);
  });
});

describe("validateSemanticPatchRequest — envelope", () => {
  test("rejects non-object body", () => {
    expectThrows(() => validateSemanticPatchRequest("x"), /Semantic patch request/);
  });

  test("rejects missing event", () => {
    expectThrows(() => validateSemanticPatchRequest({}), /event is required/);
  });

  test("rejects non-object event", () => {
    expectThrows(() => validateSemanticPatchRequest({ event: 5 }), /event/);
  });

  test("rejects missing event.type", () => {
    expectThrows(
      () => validateSemanticPatchRequest({ event: { query: "x" } }),
      /event\.type must be a string/,
    );
  });

  test("rejects unknown event.type", () => {
    expectThrows(
      () => validateSemanticPatchRequest({ event: { type: "bogus" } }),
      /not recognized/,
    );
  });
});

describe("validateSemanticPatchRequest — start event", () => {
  test("accepts valid start", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "start", query: "hello world" },
    });
    expect(out.event).toEqual({ type: "start", query: "hello world" });
  });

  test("rejects extra field on start", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "start", query: "x", extra: "y" },
        }),
      /unexpected field "extra"/,
    );
  });

  test("rejects empty / whitespace query", () => {
    expectThrows(
      () => validateSemanticPatchRequest({ event: { type: "start", query: "  " } }),
      /non-empty string/,
    );
  });

  test("rejects oversized query", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "start", query: "x".repeat(20_001) },
        }),
      /too large/,
    );
  });
});

describe("validateSemanticPatchRequest — clarificationsReceived event", () => {
  const baseQ = { id: "q1", question: "What scope?" };

  test("accepts well-formed questions list with defaults + whys", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "clarificationsReceived",
        questions: [
          { id: "q1", question: "What region?", defaultAnswer: "US", why: "Geo matters." },
          { id: "q2", question: "What timeframe?" },
        ],
      },
    });
    expect(out.event).toMatchObject({
      type: "clarificationsReceived",
      questions: [
        { id: "q1", question: "What region?", defaultAnswer: "US", why: "Geo matters." },
        { id: "q2", question: "What timeframe?" },
      ],
    });
  });

  test("rejects non-array questions", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "clarificationsReceived", questions: "q" },
        }),
      /must be an array/,
    );
  });

  test("rejects non-object question entry", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "clarificationsReceived", questions: ["q"] },
        }),
      /questions\[0\] must be an object/,
    );
  });

  test("rejects empty id on a question", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "clarificationsReceived",
            questions: [{ ...baseQ, id: "" }],
          },
        }),
      /questions\[0\]\.id/,
    );
  });

  test("rejects non-string question text", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "clarificationsReceived",
            questions: [{ id: "q1", question: 5 }],
          },
        }),
      /questions\[0\]\.question/,
    );
  });

  test("rejects non-string defaultAnswer", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "clarificationsReceived",
            questions: [{ ...baseQ, defaultAnswer: 1 }],
          },
        }),
      /defaultAnswer/,
    );
  });

  test("rejects non-string why", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "clarificationsReceived",
            questions: [{ ...baseQ, why: 7 }],
          },
        }),
      /why/,
    );
  });
});

describe("validateSemanticPatchRequest — answerClarification event", () => {
  test("accepts valid answer", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "answerClarification", qId: "q1", answer: "yes" },
    });
    expect(out.event).toEqual({ type: "answerClarification", qId: "q1", answer: "yes" });
  });

  test("accepts empty-string answer (user clearing a field)", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "answerClarification", qId: "q1", answer: "" },
    });
    expect(out.event).toEqual({ type: "answerClarification", qId: "q1", answer: "" });
  });

  test("rejects missing qId", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "answerClarification", answer: "x" },
        }),
      /qId/,
    );
  });

  test("rejects non-string answer", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "answerClarification", qId: "q1", answer: 5 },
        }),
      /answer/,
    );
  });
});

describe("validateSemanticPatchRequest — submitClarifications", () => {
  test("accepts the bare event", () => {
    const out = validateSemanticPatchRequest({ event: { type: "submitClarifications" } });
    expect(out.event).toEqual({ type: "submitClarifications" });
  });

  test("rejects extra field", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "submitClarifications", payload: 1 },
        }),
      /unexpected field "payload"/,
    );
  });
});

describe("validateSemanticPatchRequest — componentsReceived event", () => {
  const okComponent = {
    id: "c1",
    name: "Sales growth",
    description: "Monthly sales growth rate.",
    suggestedDistribution: "normal",
    why: "Drives total revenue.",
    dependsOn: ["c0"],
  };

  test("accepts a list of well-formed components", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "componentsReceived", components: [okComponent] },
    });
    expect(out.event).toMatchObject({
      type: "componentsReceived",
      components: [okComponent],
    });
  });

  test("rejects non-array components", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "componentsReceived", components: {} },
        }),
      /must be an array/,
    );
  });

  test("rejects non-object component entry", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "componentsReceived", components: [5] },
        }),
      /components\[0\] must be an object/,
    );
  });

  test("rejects component missing id", () => {
    const { id: _id, ...without } = okComponent;
    void _id;
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "componentsReceived", components: [without] },
        }),
      /components\[0\]\.id/,
    );
  });

  test("rejects component with non-string description", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "componentsReceived",
            components: [{ ...okComponent, description: 5 }],
          },
        }),
      /description must be a string/,
    );
  });

  test("rejects component with unsupported suggestedDistribution", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "componentsReceived",
            components: [{ ...okComponent, suggestedDistribution: "exponential" }],
          },
        }),
      /not a supported distribution/,
    );
  });

  test("rejects component with non-array dependsOn", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "componentsReceived",
            components: [{ ...okComponent, dependsOn: "c0" }],
          },
        }),
      /dependsOn must be an array/,
    );
  });

  test("rejects component with empty dependsOn entry", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "componentsReceived",
            components: [{ ...okComponent, dependsOn: [""] }],
          },
        }),
      /dependsOn\[0\]/,
    );
  });

  test("rejects non-string why", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "componentsReceived",
            components: [{ ...okComponent, why: 1 }],
          },
        }),
      /why must be a string/,
    );
  });

  test("accepts component without optional fields", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "componentsReceived",
        components: [{ id: "c1", name: "C1", description: "d" }],
      },
    });
    expect(out.event).toMatchObject({
      type: "componentsReceived",
      components: [{ id: "c1", name: "C1", description: "d" }],
    });
  });
});

describe("validateSemanticPatchRequest — editComponent event", () => {
  test("accepts a well-formed patch with all editable fields", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "editComponent",
        componentId: "c1",
        patch: {
          name: "Renamed",
          description: "Updated description.",
          suggestedDistribution: "triangular",
          dependsOn: ["c2"],
          why: "Updated reasoning.",
        },
      },
    });
    expect(out.event).toMatchObject({
      type: "editComponent",
      componentId: "c1",
      patch: {
        name: "Renamed",
        suggestedDistribution: "triangular",
      },
    });
  });

  test("accepts an empty patch (no-op)", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "editComponent", componentId: "c1", patch: {} },
    });
    expect(out.event).toMatchObject({ type: "editComponent", componentId: "c1" });
  });

  test("rejects missing componentId", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "editComponent", patch: {} },
        }),
      /componentId/,
    );
  });

  test("rejects non-object patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "editComponent", componentId: "c1", patch: "x" },
        }),
      /patch must be an object/,
    );
  });

  test("rejects unknown patch field", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { range: [0, 1] },
          },
        }),
      /unexpected field "range"/,
    );
  });

  test("rejects empty name in patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { name: "  " },
          },
        }),
      /name must be a non-empty string/,
    );
  });

  test("rejects non-string description in patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { description: 5 },
          },
        }),
      /description must be a string/,
    );
  });

  test("rejects unsupported distribution in patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { suggestedDistribution: "poisson" },
          },
        }),
      /not a supported distribution/,
    );
  });

  test("rejects non-array dependsOn in patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { dependsOn: "x" },
          },
        }),
      /dependsOn must be an array/,
    );
  });

  test("rejects empty-string dependsOn entry in patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { dependsOn: [""] },
          },
        }),
      /dependsOn\[0\]/,
    );
  });

  test("rejects non-string why in patch", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "editComponent",
            componentId: "c1",
            patch: { why: 5 },
          },
        }),
      /why must be a string/,
    );
  });
});

describe("validateSemanticPatchRequest — acceptComponents / runModel / acceptResult / back / reset", () => {
  test.each([
    ["acceptComponents"],
    ["runModel"],
    ["acceptResult"],
    ["back"],
    ["reset"],
  ])("accepts bare %s", (type) => {
    const out = validateSemanticPatchRequest({ event: { type } });
    expect((out.event as { type: string }).type).toBe(type);
  });

  test.each([
    ["acceptComponents"],
    ["runModel"],
    ["acceptResult"],
    ["back"],
    ["reset"],
  ])("rejects extra field on %s", (type) => {
    expectThrows(
      () => validateSemanticPatchRequest({ event: { type, payload: 1 } }),
      /unexpected field "payload"/,
    );
  });
});

describe("validateSemanticPatchRequest — setThreshold event", () => {
  test("accepts numeric threshold + non-empty label", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "setThreshold",
        threshold: 0.7,
        thresholdLabel: "high risk",
      },
    });
    expect(out.event).toEqual({
      type: "setThreshold",
      threshold: 0.7,
      thresholdLabel: "high risk",
    });
  });

  test("rejects non-finite threshold", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "setThreshold",
            threshold: Number.NaN,
            thresholdLabel: "x",
          },
        }),
      /threshold/,
    );
  });

  test("rejects whitespace thresholdLabel", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "setThreshold",
            threshold: 0.5,
            thresholdLabel: "   ",
          },
        }),
      /thresholdLabel/,
    );
  });
});

describe("validateSemanticPatchRequest — startResearch event", () => {
  test("accepts every valid mechanism", () => {
    for (const mechanism of [
      "llm_prior",
      "web_search",
      "rag_document",
      "multi_llm_consensus",
      "ensemble_forecast",
      "empirical_observation",
      "expert_panel",
    ] as const) {
      const out = validateSemanticPatchRequest({
        event: { type: "startResearch", componentId: "c1", mechanism },
      });
      expect(out.event).toEqual({
        type: "startResearch",
        componentId: "c1",
        mechanism,
      });
    }
  });

  test("rejects unrecognized mechanism", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "startResearch", componentId: "c1", mechanism: "vibes" },
        }),
      /not a recognized research mechanism/,
    );
  });

  test("rejects missing componentId", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "startResearch", mechanism: "llm_prior" },
        }),
      /componentId/,
    );
  });
});

describe("validateSemanticPatchRequest — researchReceived event", () => {
  const goodBundle = {
    componentId: "c1",
    mechanism: "llm_prior",
    proposedDistribution: "beta",
    proposedParams: { alpha: 2, beta: 5 },
    reasoning: "Bounded probability with skew.",
  };

  test("accepts a well-formed bundle", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "researchReceived", componentId: "c1", bundle: goodBundle },
    });
    expect(out.event).toMatchObject({
      type: "researchReceived",
      componentId: "c1",
      bundle: { componentId: "c1", proposedDistribution: "beta" },
    });
  });

  test("rejects non-object bundle", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "researchReceived", componentId: "c1", bundle: 5 },
        }),
      /bundle must be an object/,
    );
  });

  test("rejects bundle missing componentId", () => {
    const { componentId: _, ...without } = goodBundle;
    void _;
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "researchReceived", componentId: "c1", bundle: without },
        }),
      /bundle\.componentId/,
    );
  });

  test("rejects bundle with unknown mechanism", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: { ...goodBundle, mechanism: "vibes" },
          },
        }),
      /bundle\.mechanism/,
    );
  });

  test("rejects bundle with unsupported distribution", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: { ...goodBundle, proposedDistribution: "poisson" },
          },
        }),
      /proposedDistribution/,
    );
  });

  test("rejects bundle with non-object proposedParams", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: { ...goodBundle, proposedParams: 5 },
          },
        }),
      /proposedParams must be an object/,
    );
  });

  test("rejects bundle with non-string reasoning", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: { ...goodBundle, reasoning: 5 },
          },
        }),
      /reasoning must be a string/,
    );
  });

  test("accepts bundle without citations (legacy / minimal)", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "researchReceived", componentId: "c1", bundle: goodBundle },
    });
    const validatedBundle = (
      out.event as { bundle: { citations?: unknown[] } }
    ).bundle;
    expect(validatedBundle.citations).toBeUndefined();
  });

  test("preserves llm_prior citations shape ({source} only)", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "researchReceived",
        componentId: "c1",
        bundle: {
          ...goodBundle,
          citations: [{ source: "Wells score 2019 meta-analysis" }],
        },
      },
    });
    const bundle = (out.event as { bundle: { citations: unknown[] } }).bundle;
    expect(bundle.citations).toEqual([
      { source: "Wells score 2019 meta-analysis" },
    ]);
  });

  test("preserves web_search citations shape ({url, title, snippet})", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "researchReceived",
        componentId: "c1",
        bundle: {
          ...goodBundle,
          citations: [
            {
              url: "https://example.com/study",
              title: "B2B SaaS growth rates",
              snippet: "Median annual growth ranges 25-45%.",
            },
          ],
        },
      },
    });
    const bundle = (out.event as { bundle: { citations: unknown[] } }).bundle;
    expect(bundle.citations).toEqual([
      {
        url: "https://example.com/study",
        title: "B2B SaaS growth rates",
        snippet: "Median annual growth ranges 25-45%.",
      },
    ]);
  });

  test("preserves rag_document citations shape ({documentId, chunkId, chunkText, sourceFilename})", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "researchReceived",
        componentId: "c1",
        bundle: {
          ...goodBundle,
          citations: [
            {
              documentId: "doc_123",
              chunkId: 7,
              chunkText: "Benchmark median is 0.18 in cohort B.",
              sourceFilename: "saas-benchmarks-2025.md",
            },
          ],
        },
      },
    });
    const bundle = (out.event as { bundle: { citations: unknown[] } }).bundle;
    expect(bundle.citations).toEqual([
      {
        documentId: "doc_123",
        chunkId: 7,
        chunkText: "Benchmark median is 0.18 in cohort B.",
        sourceFilename: "saas-benchmarks-2025.md",
      },
    ]);
  });

  test("accepts chunkId as string", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "researchReceived",
        componentId: "c1",
        bundle: {
          ...goodBundle,
          citations: [
            {
              documentId: "doc_x",
              chunkId: "uuid-abc",
              chunkText: "...",
              sourceFilename: "x.pdf",
            },
          ],
        },
      },
    });
    const bundle = (out.event as { bundle: { citations: unknown[] } }).bundle;
    expect((bundle.citations as Array<{ chunkId: unknown }>)[0].chunkId).toBe(
      "uuid-abc",
    );
  });

  test("rejects non-array citations", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: { ...goodBundle, citations: "not-an-array" },
          },
        }),
      /must be an array/,
    );
  });

  test("rejects citation entry that is not an object", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: { ...goodBundle, citations: ["just a string"] },
          },
        }),
      /citations\[0\] must be an object/,
    );
  });

  test("rejects citation entry with no identifying field (no source / url / documentId)", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: {
              ...goodBundle,
              citations: [{ snippet: "orphan snippet with no source" }],
            },
          },
        }),
      /at least one of 'source', 'url', or 'documentId'/,
    );
  });

  test("rejects citation with wrong-type field (e.g. numeric title alongside valid source)", () => {
    // Provide a valid `source` so the identifier check passes; then the
    // per-field type check fires on the numeric `title`.
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: {
              ...goodBundle,
              citations: [{ source: "x", title: 123 }],
            },
          },
        }),
      /title must be a string/,
    );
  });

  test("rejects citation with chunkId that's neither string nor number", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: {
            type: "researchReceived",
            componentId: "c1",
            bundle: {
              ...goodBundle,
              citations: [
                {
                  documentId: "doc_x",
                  chunkId: { invalid: true },
                  chunkText: "x",
                  sourceFilename: "x.md",
                },
              ],
            },
          },
        }),
      /chunkId must be a string or number/,
    );
  });

  test("preserves unknown extra fields verbatim (open shape)", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "researchReceived",
        componentId: "c1",
        bundle: {
          ...goodBundle,
          citations: [
            {
              source: "model:gpt-x",
              snippet: "reasoning text",
              modelLatencyMs: 1234, // unknown but harmless
            },
          ],
        },
      },
    });
    const bundle = (out.event as { bundle: { citations: unknown[] } }).bundle;
    expect((bundle.citations as Array<Record<string, unknown>>)[0]).toEqual({
      source: "model:gpt-x",
      snippet: "reasoning text",
      modelLatencyMs: 1234,
    });
  });
});

describe("validateSemanticPatchRequest — acceptResearch event", () => {
  test("accepts valid event", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "acceptResearch", componentId: "c1" },
    });
    expect(out.event).toEqual({ type: "acceptResearch", componentId: "c1" });
  });

  test("rejects empty componentId", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "acceptResearch", componentId: " " },
        }),
      /componentId/,
    );
  });
});

describe("validateSemanticPatchRequest — modelComplete event", () => {
  test("accepts a result object verbatim (no schema constraints today)", () => {
    const out = validateSemanticPatchRequest({
      event: {
        type: "modelComplete",
        result: {
          topSensitivityComponentId: "c1",
          pAboveThreshold: 0.42,
          raw: { samples: [1, 2, 3] },
        },
      },
    });
    expect(out.event).toMatchObject({
      type: "modelComplete",
      result: { pAboveThreshold: 0.42 },
    });
  });

  test("rejects non-object result", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "modelComplete", result: 5 },
        }),
      /result must be an object/,
    );
  });
});

describe("validateSemanticPatchRequest — verifyNext event", () => {
  test("accepts valid componentId", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "verifyNext", componentId: "c1" },
    });
    expect(out.event).toEqual({ type: "verifyNext", componentId: "c1" });
  });

  test("rejects empty componentId", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({
          event: { type: "verifyNext", componentId: "" },
        }),
      /componentId/,
    );
  });
});

describe("validateSemanticPatchRequest — fail event", () => {
  test("accepts non-empty message", () => {
    const out = validateSemanticPatchRequest({
      event: { type: "fail", message: "Provider timeout" },
    });
    expect(out.event).toEqual({ type: "fail", message: "Provider timeout" });
  });

  test("rejects empty / whitespace message", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({ event: { type: "fail", message: "  " } }),
      /non-empty string/,
    );
  });

  test("rejects non-string message", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest({ event: { type: "fail", message: 5 } }),
      /non-empty string/,
    );
  });
});

describe("validateSemanticPatchRequest — startResearch event with inputs (B6)", () => {
  function buildStartResearch(
    componentId: string,
    mechanism: string,
    inputs?: Record<string, unknown>,
  ): unknown {
    const event: Record<string, unknown> = {
      type: "startResearch",
      componentId,
      mechanism,
    };
    if (inputs !== undefined) event.inputs = inputs;
    return { event };
  }

  test("accepts startResearch without inputs (LLM-only mechanisms)", () => {
    const out = validateSemanticPatchRequest(
      buildStartResearch("c1", "llm_prior"),
    );
    expect(out.event).toMatchObject({
      type: "startResearch",
      componentId: "c1",
      mechanism: "llm_prior",
    });
  });

  test("rejects unknown inputs key", () => {
    expectThrows(
      () =>
        validateSemanticPatchRequest(
          buildStartResearch("c1", "llm_prior", { wormhole: true }),
        ),
      /unexpected field "wormhole"/,
    );
  });

  describe("csvRows input", () => {
    const baseRow = { date: "2024-01-01", value: 10 };

    test("accepts numeric + string cells", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "ensemble_forecast", {
          csvRows: [baseRow, { date: "2024-01-02", value: 11.5 }],
        }),
      );
      expect((out.event as { inputs: { csvRows: unknown[] } }).inputs.csvRows).toHaveLength(2);
    });

    test("coerces null cells to empty string", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "ensemble_forecast", {
          csvRows: [{ date: "2024-01-01", value: null }],
        }),
      );
      const rows = (out.event as { inputs: { csvRows: Array<Record<string, unknown>> } }).inputs.csvRows;
      expect(rows[0].value).toBe("");
    });

    test("rejects non-array csvRows", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "ensemble_forecast", { csvRows: "csv" }),
          ),
        /csvRows must be an array/,
      );
    });

    test("rejects csv row that is not an object", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "ensemble_forecast", { csvRows: ["row1"] }),
          ),
        /csvRows\[0\] must be an object/,
      );
    });

    test("rejects non-scalar cell value", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "ensemble_forecast", {
              csvRows: [{ date: "2024-01-01", value: { nested: true } }],
            }),
          ),
        /must be a string, number, or null/,
      );
    });

    test("rejects csvRows exceeding cap", () => {
      const huge = Array.from({ length: 10_001 }, () => baseRow);
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "ensemble_forecast", { csvRows: huge }),
          ),
        /exceeds 10000 rows/,
      );
    });
  });

  describe("date / target columns", () => {
    test("accepts non-empty strings", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "ensemble_forecast", {
          dateColumn: "date",
          targetColumn: "value",
        }),
      );
      const inputs = (out.event as { inputs: { dateColumn: string; targetColumn: string } }).inputs;
      expect(inputs.dateColumn).toBe("date");
      expect(inputs.targetColumn).toBe("value");
    });

    test("rejects empty dateColumn", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "ensemble_forecast", { dateColumn: "  " }),
          ),
        /dateColumn must be a non-empty string/,
      );
    });

    test("rejects empty targetColumn", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "empirical_observation", { targetColumn: "" }),
          ),
        /targetColumn must be a non-empty string/,
      );
    });
  });

  describe("horizon + threshold", () => {
    test("accepts finite horizon", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "ensemble_forecast", { horizon: 2 }),
      );
      expect((out.event as { inputs: { horizon: number } }).inputs.horizon).toBe(2);
    });

    test("rejects non-finite horizon", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "ensemble_forecast", { horizon: Number.POSITIVE_INFINITY }),
          ),
        /horizon must be a finite number/,
      );
    });

    test("accepts threshold as a finite number", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "empirical_observation", { threshold: 0.5 }),
      );
      expect((out.event as { inputs: { threshold: unknown } }).inputs.threshold).toBe(0.5);
    });

    test("accepts threshold as null (cleared)", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "empirical_observation", { threshold: null }),
      );
      expect((out.event as { inputs: { threshold: unknown } }).inputs.threshold).toBeNull();
    });

    test("rejects threshold as NaN", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "empirical_observation", {
              threshold: Number.NaN,
            }),
          ),
        /threshold must be a finite number or null/,
      );
    });
  });

  describe("estimates (expert_panel)", () => {
    test("accepts an array of finite numbers", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "expert_panel", { estimates: [10, 20, 30] }),
      );
      expect((out.event as { inputs: { estimates: number[] } }).inputs.estimates).toEqual([10, 20, 30]);
    });

    test("rejects non-array estimates", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", { estimates: "ten" }),
          ),
        /estimates must be an array/,
      );
    });

    test("rejects estimates exceeding the cap", () => {
      const huge = Array.from({ length: 101 }, (_, i) => i);
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", { estimates: huge }),
          ),
        /exceeds 100 entries/,
      );
    });

    test("rejects non-finite estimate naming the index", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", {
              estimates: [1, Number.NaN, 3],
            }),
          ),
        /estimates\[1\] must be a finite number/,
      );
    });
  });

  describe("labels (expert_panel)", () => {
    test("accepts string labels", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "expert_panel", {
          labels: ["alice", "bob"],
        }),
      );
      expect((out.event as { inputs: { labels: string[] } }).inputs.labels).toEqual(["alice", "bob"]);
    });

    test("rejects non-array labels", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", { labels: 5 }),
          ),
        /labels must be an array/,
      );
    });

    test("rejects non-string label", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", { labels: ["alice", 7] }),
          ),
        /labels\[1\] must be a string/,
      );
    });
  });

  describe("hardBounds (expert_panel)", () => {
    test("accepts min < max", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "expert_panel", {
          hardBounds: { min: 0, max: 100 },
        }),
      );
      const hb = (out.event as { inputs: { hardBounds: { min: number; max: number } } }).inputs.hardBounds;
      expect(hb).toEqual({ min: 0, max: 100 });
    });

    test("rejects non-object hardBounds", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", { hardBounds: [0, 100] }),
          ),
        /hardBounds must be an object/,
      );
    });

    test("rejects min === max", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", {
              hardBounds: { min: 1, max: 1 },
            }),
          ),
        /min < max/,
      );
    });

    test("rejects non-finite bounds", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", {
              hardBounds: { min: 0, max: Number.POSITIVE_INFINITY },
            }),
          ),
        /must be finite numbers/,
      );
    });
  });

  describe("distribution override", () => {
    test("accepts every valid distribution", () => {
      for (const dist of ["normal", "beta", "uniform", "lognormal", "triangular"]) {
        const out = validateSemanticPatchRequest(
          buildStartResearch("c1", "expert_panel", { distribution: dist }),
        );
        const inputs = (out.event as { inputs: { distribution: string } }).inputs;
        expect(inputs.distribution).toBe(dist);
      }
    });

    test("rejects unsupported distribution", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "expert_panel", { distribution: "poisson" }),
          ),
        /not a supported distribution/,
      );
    });
  });

  describe("documentIds (rag_document)", () => {
    test("accepts an array of non-empty strings", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "rag_document", {
          documentIds: ["doc_a", "doc_b"],
        }),
      );
      const ids = (out.event as { inputs: { documentIds: string[] } }).inputs.documentIds;
      expect(ids).toEqual(["doc_a", "doc_b"]);
    });

    test("rejects non-array documentIds", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "rag_document", { documentIds: "doc" }),
          ),
        /documentIds must be an array/,
      );
    });

    test("rejects empty-string id", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "rag_document", {
              documentIds: ["doc_a", " "],
            }),
          ),
        /documentIds\[1\] must be a non-empty string/,
      );
    });

    test("rejects too many ids", () => {
      const huge = Array.from({ length: 201 }, (_, i) => `doc_${i}`);
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "rag_document", { documentIds: huge }),
          ),
        /exceeds 200 entries/,
      );
    });
  });

  describe("searchMaxResults + searchQuery (web_search)", () => {
    test("accepts finite positive searchMaxResults; floors to integer", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "web_search", { searchMaxResults: 5.7 }),
      );
      const inputs = (out.event as { inputs: { searchMaxResults: number } }).inputs;
      expect(inputs.searchMaxResults).toBe(5);
    });

    test("rejects zero searchMaxResults", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "web_search", { searchMaxResults: 0 }),
          ),
        /finite positive/,
      );
    });

    test("accepts searchQuery", () => {
      const out = validateSemanticPatchRequest(
        buildStartResearch("c1", "web_search", { searchQuery: "saas churn" }),
      );
      const inputs = (out.event as { inputs: { searchQuery: string } }).inputs;
      expect(inputs.searchQuery).toBe("saas churn");
    });

    test("rejects non-string searchQuery", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "web_search", { searchQuery: 5 }),
          ),
        /searchQuery must be a string/,
      );
    });

    test("rejects overly long searchQuery", () => {
      expectThrows(
        () =>
          validateSemanticPatchRequest(
            buildStartResearch("c1", "web_search", {
              searchQuery: "x".repeat(1001),
            }),
          ),
        /too long/,
      );
    });
  });
});
