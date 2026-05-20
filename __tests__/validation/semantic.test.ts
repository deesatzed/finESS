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
