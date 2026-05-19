import {
  evaluateRecurrence,
  applyTransition,
  RecurrenceEvaluationError,
  type RecurrenceContext,
} from "@/lib/engine/recurrence";
import type { RecurrenceExpr, TransitionRecurrence } from "@/lib/types";

const emptyCtx: RecurrenceContext = { state: {}, samples: {} };

describe("evaluateRecurrence — literals and references", () => {
  test("literal returns its numeric value", () => {
    expect(evaluateRecurrence({ kind: "literal", value: 3.14 }, emptyCtx)).toBe(3.14);
    expect(evaluateRecurrence({ kind: "literal", value: 0 }, emptyCtx)).toBe(0);
    expect(evaluateRecurrence({ kind: "literal", value: -42 }, emptyCtx)).toBe(-42);
  });

  test("state reads from context.state by name", () => {
    const ctx: RecurrenceContext = { state: { portfolio: 1_000_000 }, samples: {} };
    expect(evaluateRecurrence({ kind: "state", name: "portfolio" }, ctx)).toBe(
      1_000_000
    );
  });

  test("sample reads from context.samples by nodeId", () => {
    const ctx: RecurrenceContext = {
      state: {},
      samples: { annual_return: 0.07 },
    };
    expect(
      evaluateRecurrence({ kind: "sample", nodeId: "annual_return" }, ctx)
    ).toBeCloseTo(0.07);
  });

  test("state throws RecurrenceEvaluationError with the variable name on unknown var", () => {
    const ctx: RecurrenceContext = { state: { portfolio: 1 }, samples: {} };
    expect(() =>
      evaluateRecurrence({ kind: "state", name: "missing_var" }, ctx)
    ).toThrow(RecurrenceEvaluationError);
    expect(() =>
      evaluateRecurrence({ kind: "state", name: "missing_var" }, ctx)
    ).toThrow(/missing_var/);
  });

  test("sample throws RecurrenceEvaluationError with the node id on unknown id", () => {
    const ctx: RecurrenceContext = { state: {}, samples: { real_node: 1 } };
    expect(() =>
      evaluateRecurrence({ kind: "sample", nodeId: "ghost_node" }, ctx)
    ).toThrow(RecurrenceEvaluationError);
    expect(() =>
      evaluateRecurrence({ kind: "sample", nodeId: "ghost_node" }, ctx)
    ).toThrow(/ghost_node/);
  });
});

describe("evaluateRecurrence — arithmetic operators", () => {
  const ctx: RecurrenceContext = {
    state: { a: 10, b: 4 },
    samples: { s: 2 },
  };

  test("add", () => {
    const expr: RecurrenceExpr = {
      kind: "add",
      left: { kind: "state", name: "a" },
      right: { kind: "state", name: "b" },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(14);
  });

  test("subtract", () => {
    const expr: RecurrenceExpr = {
      kind: "subtract",
      left: { kind: "state", name: "a" },
      right: { kind: "state", name: "b" },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(6);
  });

  test("multiply", () => {
    const expr: RecurrenceExpr = {
      kind: "multiply",
      left: { kind: "state", name: "a" },
      right: { kind: "sample", nodeId: "s" },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(20);
  });

  test("divide returns left / right", () => {
    const expr: RecurrenceExpr = {
      kind: "divide",
      left: { kind: "state", name: "a" },
      right: { kind: "state", name: "b" },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(2.5);
  });

  test("divide throws on right == 0", () => {
    const zeroCtx: RecurrenceContext = { state: { a: 1, z: 0 }, samples: {} };
    const expr: RecurrenceExpr = {
      kind: "divide",
      left: { kind: "state", name: "a" },
      right: { kind: "state", name: "z" },
    };
    expect(() => evaluateRecurrence(expr, zeroCtx)).toThrow(
      RecurrenceEvaluationError
    );
    expect(() => evaluateRecurrence(expr, zeroCtx)).toThrow(/divide-by-zero/);
  });

  test("max and min", () => {
    const maxExpr: RecurrenceExpr = {
      kind: "max",
      left: { kind: "state", name: "a" },
      right: { kind: "state", name: "b" },
    };
    const minExpr: RecurrenceExpr = {
      kind: "min",
      left: { kind: "state", name: "a" },
      right: { kind: "state", name: "b" },
    };
    expect(evaluateRecurrence(maxExpr, ctx)).toBe(10);
    expect(evaluateRecurrence(minExpr, ctx)).toBe(4);
  });
});

describe("evaluateRecurrence — ifGreater conditional", () => {
  test("picks `then` branch when left > right", () => {
    const ctx: RecurrenceContext = { state: { x: 5 }, samples: {} };
    const expr: RecurrenceExpr = {
      kind: "ifGreater",
      left: { kind: "state", name: "x" },
      right: { kind: "literal", value: 3 },
      then: { kind: "literal", value: 100 },
      else: { kind: "literal", value: -100 },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(100);
  });

  test("picks `else` branch when left <= right (equality goes to else)", () => {
    const ctxLess: RecurrenceContext = { state: { x: 2 }, samples: {} };
    const ctxEqual: RecurrenceContext = { state: { x: 3 }, samples: {} };
    const expr: RecurrenceExpr = {
      kind: "ifGreater",
      left: { kind: "state", name: "x" },
      right: { kind: "literal", value: 3 },
      then: { kind: "literal", value: 100 },
      else: { kind: "literal", value: -100 },
    };
    expect(evaluateRecurrence(expr, ctxLess)).toBe(-100);
    expect(evaluateRecurrence(expr, ctxEqual)).toBe(-100);
  });

  test("does not evaluate the unused branch's side conditions (lazy semantics)", () => {
    // The `then` branch would divide by zero; we should NOT reach it
    // because left (= 1) is not > right (= 5).
    const ctx: RecurrenceContext = { state: { x: 1 }, samples: {} };
    const expr: RecurrenceExpr = {
      kind: "ifGreater",
      left: { kind: "state", name: "x" },
      right: { kind: "literal", value: 5 },
      then: {
        kind: "divide",
        left: { kind: "literal", value: 1 },
        right: { kind: "literal", value: 0 },
      },
      else: { kind: "literal", value: 42 },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(42);
  });
});

describe("evaluateRecurrence — nested composition", () => {
  test("(state.a + sample.s) * literal(3) over deeply nested expr", () => {
    const ctx: RecurrenceContext = { state: { a: 10 }, samples: { s: 5 } };
    const expr: RecurrenceExpr = {
      kind: "multiply",
      left: {
        kind: "add",
        left: { kind: "state", name: "a" },
        right: { kind: "sample", nodeId: "s" },
      },
      right: { kind: "literal", value: 3 },
    };
    expect(evaluateRecurrence(expr, ctx)).toBe(45);
  });
});

describe("applyTransition", () => {
  test("variables not in updates carry through unchanged", () => {
    const recurrence: TransitionRecurrence = {
      updates: {
        a: { kind: "literal", value: 99 },
      },
    };
    const state = { a: 1, b: 2, c: 3 };
    const next = applyTransition(recurrence, state, {});
    expect(next).toEqual({ a: 99, b: 2, c: 3 });
  });

  test("RHS evaluations see a snapshot of the pre-update state (order-independent)", () => {
    // updates: a' = b, b' = a. After one step state should swap.
    // If we mutated state in place during iteration, both could end up
    // equal — proving the snapshot semantics matters.
    const recurrence: TransitionRecurrence = {
      updates: {
        a: { kind: "state", name: "b" },
        b: { kind: "state", name: "a" },
      },
    };
    const state = { a: 1, b: 2 };
    const next = applyTransition(recurrence, state, {});
    expect(next).toEqual({ a: 2, b: 1 });
  });

  test("empty updates returns a shallow copy of state", () => {
    const recurrence: TransitionRecurrence = { updates: {} };
    const state = { a: 1, b: 2 };
    const next = applyTransition(recurrence, state, {});
    expect(next).toEqual(state);
    expect(next).not.toBe(state);
  });

  test("can introduce a new variable not present in the input state", () => {
    const recurrence: TransitionRecurrence = {
      updates: {
        c: { kind: "literal", value: 5 },
      },
    };
    const state = { a: 1 };
    const next = applyTransition(recurrence, state, {});
    expect(next).toEqual({ a: 1, c: 5 });
  });
});
