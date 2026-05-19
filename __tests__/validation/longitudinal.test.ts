import {
  validateLongitudinalSpecifics,
  validateRecurrenceExpr,
  validateTransitionRecurrence,
} from "@/lib/validation/longitudinal";
import { ValidationError } from "@/lib/validation/schemas";
import type { UncertaintyGraph } from "@/lib/types";

const baseGraph: UncertaintyGraph = {
  nodes: [
    {
      id: "ret",
      name: "Return",
      description: "annual return",
      distribution: "normal",
      mean: 0.07,
      sd: 0.155,
      range: [-0.4, 0.5],
      unit: "%",
    },
  ],
  edges: [],
  outputNodeId: "ret",
};

describe("validateRecurrenceExpr (C3b)", () => {
  test("accepts a literal", () => {
    expect(validateRecurrenceExpr({ kind: "literal", value: 1.5 })).toEqual({
      kind: "literal",
      value: 1.5,
    });
  });

  test("rejects literal with non-finite value", () => {
    expect(() =>
      validateRecurrenceExpr({ kind: "literal", value: Number.POSITIVE_INFINITY })
    ).toThrow(/finite numeric/);
  });

  test("accepts a state reference", () => {
    expect(validateRecurrenceExpr({ kind: "state", name: "portfolio" })).toEqual({
      kind: "state",
      name: "portfolio",
    });
  });

  test("rejects empty state name", () => {
    expect(() => validateRecurrenceExpr({ kind: "state", name: "" })).toThrow(
      /non-empty 'name'/
    );
  });

  test("accepts sample reference", () => {
    expect(validateRecurrenceExpr({ kind: "sample", nodeId: "ret" })).toEqual({
      kind: "sample",
      nodeId: "ret",
    });
  });

  test("accepts nested add", () => {
    const expr = validateRecurrenceExpr({
      kind: "add",
      left: { kind: "state", name: "portfolio" },
      right: { kind: "sample", nodeId: "ret" },
    });
    expect(expr.kind).toBe("add");
  });

  test("rejects unknown kind", () => {
    expect(() => validateRecurrenceExpr({ kind: "exp", value: 2 })).toThrow(
      /invalid kind/
    );
  });

  test("rejects malformed nested expression with path in error", () => {
    expect(() =>
      validateRecurrenceExpr({
        kind: "multiply",
        left: { kind: "literal", value: 2 },
        right: { kind: "state", name: "" },
      })
    ).toThrow(/\$\.right/);
  });

  test("accepts ifGreater with all four operands", () => {
    const expr = validateRecurrenceExpr({
      kind: "ifGreater",
      left: { kind: "literal", value: 5 },
      right: { kind: "literal", value: 3 },
      then: { kind: "literal", value: 1 },
      else: { kind: "literal", value: 0 },
    });
    expect(expr.kind).toBe("ifGreater");
  });
});

describe("validateTransitionRecurrence (C3b)", () => {
  test("accepts an empty updates object", () => {
    expect(validateTransitionRecurrence({ updates: {} })).toEqual({ updates: {} });
  });

  test("rejects non-object updates", () => {
    expect(() => validateTransitionRecurrence({ updates: null })).toThrow(
      /updates must be an object/
    );
  });

  test("rejects empty update key", () => {
    expect(() =>
      validateTransitionRecurrence({
        updates: { "": { kind: "literal", value: 1 } },
      })
    ).toThrow(/empty key/);
  });
});

describe("validateLongitudinalSpecifics (C3b)", () => {
  function good(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      horizonSteps: 30,
      stateTransition: {
        initialState: { portfolio: 1_000_000 },
        recurrence: {
          updates: {
            portfolio: {
              kind: "add",
              left: { kind: "state", name: "portfolio" },
              right: { kind: "sample", nodeId: "ret" },
            },
          },
        },
      },
      outputStateVar: "portfolio",
      ...overrides,
    };
  }

  test("accepts a well-formed longitudinal graph", () => {
    const out = validateLongitudinalSpecifics(baseGraph, good());
    expect(out.horizonSteps).toBe(30);
    expect(out.outputStateVar).toBe("portfolio");
    expect(out.stateTransition.initialState.portfolio).toBe(1_000_000);
    expect(out.stateTransition.recurrence.updates.portfolio.kind).toBe("add");
  });

  test("rejects non-integer horizonSteps", () => {
    expect(() =>
      validateLongitudinalSpecifics(baseGraph, good({ horizonSteps: 1.5 }))
    ).toThrow(/positive integer/);
  });

  test("rejects zero or negative horizonSteps", () => {
    expect(() =>
      validateLongitudinalSpecifics(baseGraph, good({ horizonSteps: 0 }))
    ).toThrow(/positive integer/);
    expect(() =>
      validateLongitudinalSpecifics(baseGraph, good({ horizonSteps: -1 }))
    ).toThrow(/positive integer/);
  });

  test("rejects non-finite initialState values", () => {
    expect(() =>
      validateLongitudinalSpecifics(
        baseGraph,
        good({
          stateTransition: {
            initialState: { portfolio: Number.NaN },
            recurrence: { updates: {} },
          },
        })
      )
    ).toThrow(/finite number/);
  });

  test("rejects outputStateVar not in initialState", () => {
    expect(() =>
      validateLongitudinalSpecifics(baseGraph, good({ outputStateVar: "ghost" }))
    ).toThrow(/does not exist in stateTransition\.initialState/);
  });

  test("rejects recurrence updating undeclared state variable", () => {
    expect(() =>
      validateLongitudinalSpecifics(
        baseGraph,
        good({
          stateTransition: {
            initialState: { portfolio: 1 },
            recurrence: {
              updates: {
                cash: { kind: "literal", value: 0 },
              },
            },
          },
        })
      )
    ).toThrow(/not declared in initialState/);
  });

  test("rejects recurrence referencing unknown node id", () => {
    expect(() =>
      validateLongitudinalSpecifics(
        baseGraph,
        good({
          stateTransition: {
            initialState: { portfolio: 1 },
            recurrence: {
              updates: {
                portfolio: { kind: "sample", nodeId: "ghost" },
              },
            },
          },
        })
      )
    ).toThrow(/unknown node id 'ghost'/);
  });

  test("rejects recurrence referencing unknown state variable", () => {
    expect(() =>
      validateLongitudinalSpecifics(
        baseGraph,
        good({
          stateTransition: {
            initialState: { portfolio: 1 },
            recurrence: {
              updates: {
                portfolio: {
                  kind: "add",
                  left: { kind: "state", name: "cash" },
                  right: { kind: "literal", value: 0 },
                },
              },
            },
          },
        })
      )
    ).toThrow(/unknown state variable 'cash'/);
  });

  test("rejects payload that is not an object", () => {
    expect(() => validateLongitudinalSpecifics(baseGraph, 42)).toThrow(
      /must be an object/
    );
    expect(() => validateLongitudinalSpecifics(baseGraph, null)).toThrow(
      /must be an object/
    );
  });

  test("allows outputStateVar to be omitted", () => {
    const out = validateLongitudinalSpecifics(baseGraph, good({ outputStateVar: undefined }));
    expect(out.outputStateVar).toBeUndefined();
  });
});
