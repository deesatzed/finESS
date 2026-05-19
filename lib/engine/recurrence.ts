import type { RecurrenceExpr, TransitionRecurrence } from "@/lib/types";

/**
 * Recurrence AST evaluator for longitudinal state transitions.
 *
 * The evaluator is intentionally a pure recursive interpreter over the
 * `RecurrenceExpr` discriminated union. There is NO `eval`, NO `Function`
 * constructor, NO template-string-to-code conversion anywhere in this
 * module. Each expression node is a typed shape with named children, and
 * the operators map 1:1 to JavaScript primitives on the numeric result.
 *
 * Grammar (each expression evaluates to a number):
 *   expr := literal(value)
 *         | state(name)                          // reads previous-step state variable
 *         | sample(nodeId)                       // reads this-step sampled node value
 *         | add(left, right)
 *         | subtract(left, right)
 *         | multiply(left, right)
 *         | divide(left, right)                  // throws on right == 0
 *         | max(left, right)
 *         | min(left, right)
 *         | ifGreater(left, right, then, else)   // selects `then` when left > right else `else`
 *
 * Error policy:
 *   - Unknown state variable name           → throws RecurrenceEvaluationError
 *   - Unknown sample node id                → throws RecurrenceEvaluationError
 *   - Divide by zero                        → throws RecurrenceEvaluationError
 *     (chosen explicitly over silent ±Infinity to keep longitudinal
 *      simulations crashable-loud when a recurrence is malformed.)
 *   - NaN / non-finite intermediate result  → propagated as-is by the
 *     interpreter; callers (sampler) decide whether to validate.
 *   - Unknown expression kind               → throws RecurrenceEvaluationError
 *     (exhaustiveness guard against forgotten union members.)
 */

export class RecurrenceEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceEvaluationError";
  }
}

/**
 * Context for a single evaluation: snapshot of previous-step state and
 * the just-sampled node values for the current step. Both are passed by
 * reference but treated as read-only by the evaluator.
 */
export interface RecurrenceContext {
  /** Previous-step state values, keyed by variable name. */
  state: Readonly<Record<string, number>>;
  /** Current-step sampled node values, keyed by node id. */
  samples: Readonly<Record<string, number>>;
}

/**
 * Evaluate a recurrence expression against the given context.
 * Pure function: no side effects, no mutation of the context.
 */
export function evaluateRecurrence(
  expr: RecurrenceExpr,
  ctx: RecurrenceContext
): number {
  switch (expr.kind) {
    case "literal":
      return expr.value;

    case "state": {
      if (!Object.prototype.hasOwnProperty.call(ctx.state, expr.name)) {
        throw new RecurrenceEvaluationError(
          `Recurrence references unknown state variable: "${expr.name}"`
        );
      }
      return ctx.state[expr.name];
    }

    case "sample": {
      if (!Object.prototype.hasOwnProperty.call(ctx.samples, expr.nodeId)) {
        throw new RecurrenceEvaluationError(
          `Recurrence references unknown sample node id: "${expr.nodeId}"`
        );
      }
      return ctx.samples[expr.nodeId];
    }

    case "add":
      return evaluateRecurrence(expr.left, ctx) + evaluateRecurrence(expr.right, ctx);

    case "subtract":
      return evaluateRecurrence(expr.left, ctx) - evaluateRecurrence(expr.right, ctx);

    case "multiply":
      return evaluateRecurrence(expr.left, ctx) * evaluateRecurrence(expr.right, ctx);

    case "divide": {
      const right = evaluateRecurrence(expr.right, ctx);
      if (right === 0) {
        throw new RecurrenceEvaluationError(
          "Recurrence divide-by-zero: right operand evaluated to 0"
        );
      }
      const left = evaluateRecurrence(expr.left, ctx);
      return left / right;
    }

    case "max":
      return Math.max(
        evaluateRecurrence(expr.left, ctx),
        evaluateRecurrence(expr.right, ctx)
      );

    case "min":
      return Math.min(
        evaluateRecurrence(expr.left, ctx),
        evaluateRecurrence(expr.right, ctx)
      );

    case "ifGreater": {
      const left = evaluateRecurrence(expr.left, ctx);
      const right = evaluateRecurrence(expr.right, ctx);
      return left > right
        ? evaluateRecurrence(expr.then, ctx)
        : evaluateRecurrence(expr.else, ctx);
    }

    default: {
      // Exhaustiveness check: if a new union member is added without
      // a handler, TypeScript will catch it as a `never` assignment.
      const _exhaustive: never = expr;
      throw new RecurrenceEvaluationError(
        `Unknown recurrence expression kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}

/**
 * Apply a transition recurrence to produce the next-step state. RHS
 * evaluations all see the SAME snapshot of the previous state, so
 * update order does not matter and the recurrence cannot read its own
 * partially-updated output within a step.
 *
 * Variables present in `state` but absent from `recurrence.updates`
 * carry through to the next step unchanged.
 */
export function applyTransition(
  recurrence: TransitionRecurrence,
  state: Readonly<Record<string, number>>,
  samples: Readonly<Record<string, number>>
): Record<string, number> {
  const ctx: RecurrenceContext = { state, samples };
  const next: Record<string, number> = { ...state };
  for (const [varName, expr] of Object.entries(recurrence.updates)) {
    next[varName] = evaluateRecurrence(expr, ctx);
  }
  return next;
}
