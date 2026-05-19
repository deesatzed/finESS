/**
 * C3b: persistence / API-boundary validator for LongitudinalGraph.
 *
 * The C3a engine guards runtime invariants (positive-integer horizonSteps,
 * outputStateVar existence). This module is the *write-time* validator —
 * called whenever a longitudinal graph crosses a system boundary (API
 * request body, saved Analysis JSON, Semantic Mode export). It rejects
 * malformed AST shapes BEFORE they reach the engine so the failure mode
 * is a clean 400 with a precise message instead of a runtime crash deep
 * inside the recurrence evaluator.
 *
 * Pattern mirrors lib/validation/schemas.ts — typed throws via
 * ValidationError, no unknown keys silently accepted, every dangerous
 * value enumerated explicitly.
 */

import type {
  LongitudinalGraph,
  RecurrenceExpr,
  TransitionRecurrence,
  UncertaintyGraph,
} from "@/lib/types";
import { ValidationError } from "./schemas";

const VALID_EXPR_KINDS = [
  "literal",
  "state",
  "sample",
  "add",
  "subtract",
  "multiply",
  "divide",
  "max",
  "min",
  "ifGreater",
] as const;

type ExprKind = (typeof VALID_EXPR_KINDS)[number];

function isExprKind(value: unknown): value is ExprKind {
  return typeof value === "string" && (VALID_EXPR_KINDS as readonly string[]).includes(value);
}

/**
 * Validate a recurrence expression. Recurses into operands. Throws a
 * ValidationError with the field path on the first malformed sub-tree.
 */
export function validateRecurrenceExpr(
  expr: unknown,
  path = "$"
): RecurrenceExpr {
  if (typeof expr !== "object" || expr === null || Array.isArray(expr)) {
    throw new ValidationError(`Recurrence expression at ${path} must be an object`);
  }
  const e = expr as Record<string, unknown>;
  if (!isExprKind(e.kind)) {
    throw new ValidationError(
      `Recurrence expression at ${path} has invalid kind '${String(e.kind)}'. Allowed: ${VALID_EXPR_KINDS.join(", ")}`
    );
  }
  switch (e.kind) {
    case "literal":
      if (typeof e.value !== "number" || !Number.isFinite(e.value)) {
        throw new ValidationError(
          `Recurrence literal at ${path} must have a finite numeric 'value'`
        );
      }
      return { kind: "literal", value: e.value };
    case "state":
      if (typeof e.name !== "string" || e.name === "") {
        throw new ValidationError(
          `Recurrence state-ref at ${path} must have a non-empty 'name'`
        );
      }
      return { kind: "state", name: e.name };
    case "sample":
      if (typeof e.nodeId !== "string" || e.nodeId === "") {
        throw new ValidationError(
          `Recurrence sample-ref at ${path} must have a non-empty 'nodeId'`
        );
      }
      return { kind: "sample", nodeId: e.nodeId };
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "max":
    case "min":
      return {
        kind: e.kind,
        left: validateRecurrenceExpr(e.left, `${path}.left`),
        right: validateRecurrenceExpr(e.right, `${path}.right`),
      };
    case "ifGreater":
      return {
        kind: "ifGreater",
        left: validateRecurrenceExpr(e.left, `${path}.left`),
        right: validateRecurrenceExpr(e.right, `${path}.right`),
        then: validateRecurrenceExpr(e.then, `${path}.then`),
        else: validateRecurrenceExpr(e.else, `${path}.else`),
      };
  }
}

export function validateTransitionRecurrence(
  value: unknown,
  path = "stateTransition.recurrence"
): TransitionRecurrence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${path} must be an object`);
  }
  const r = value as Record<string, unknown>;
  if (typeof r.updates !== "object" || r.updates === null || Array.isArray(r.updates)) {
    throw new ValidationError(`${path}.updates must be an object`);
  }
  const updates: Record<string, RecurrenceExpr> = {};
  for (const [key, expr] of Object.entries(r.updates)) {
    if (key === "") {
      throw new ValidationError(`${path}.updates contains an empty key`);
    }
    updates[key] = validateRecurrenceExpr(expr, `${path}.updates['${key}']`);
  }
  return { updates };
}

/**
 * Validate the longitudinal-specific fields of a LongitudinalGraph. Does NOT
 * re-validate the parent UncertaintyGraph (use validateUncertaintyGraph from
 * lib/validation/schemas.ts for that — typically the caller validates the
 * base graph first, then passes the result to this function for the
 * longitudinal-only checks).
 *
 * Catches:
 *   - non-integer / non-positive / non-finite horizonSteps
 *   - missing or non-object stateTransition / initialState
 *   - non-finite values in initialState
 *   - outputStateVar (if set) does not exist in initialState
 *   - recurrence references state variables not in initialState
 *   - recurrence references node ids not in graph.nodes
 *   - any malformed recurrence expression
 */
export function validateLongitudinalSpecifics(
  baseGraph: UncertaintyGraph,
  raw: unknown
): LongitudinalGraph {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("LongitudinalGraph payload must be an object");
  }
  const g = raw as Record<string, unknown>;

  if (
    typeof g.horizonSteps !== "number" ||
    !Number.isFinite(g.horizonSteps) ||
    !Number.isInteger(g.horizonSteps) ||
    g.horizonSteps <= 0
  ) {
    throw new ValidationError(
      `horizonSteps must be a positive integer, got ${String(g.horizonSteps)}`
    );
  }

  if (
    typeof g.stateTransition !== "object" ||
    g.stateTransition === null ||
    Array.isArray(g.stateTransition)
  ) {
    throw new ValidationError("stateTransition must be an object");
  }
  const st = g.stateTransition as Record<string, unknown>;

  if (
    typeof st.initialState !== "object" ||
    st.initialState === null ||
    Array.isArray(st.initialState)
  ) {
    throw new ValidationError("stateTransition.initialState must be an object");
  }
  const initialState: Record<string, number> = {};
  for (const [key, value] of Object.entries(st.initialState as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(
        `stateTransition.initialState['${key}'] must be a finite number`
      );
    }
    initialState[key] = value;
  }

  const recurrence = validateTransitionRecurrence(st.recurrence);

  let outputStateVar: string | undefined;
  if (g.outputStateVar !== undefined) {
    if (typeof g.outputStateVar !== "string" || g.outputStateVar === "") {
      throw new ValidationError("outputStateVar must be a non-empty string if provided");
    }
    if (!(g.outputStateVar in initialState)) {
      throw new ValidationError(
        `outputStateVar '${g.outputStateVar}' does not exist in stateTransition.initialState`
      );
    }
    outputStateVar = g.outputStateVar;
  }

  // Cross-reference: recurrence must only reference declared state vars
  // and declared node ids. Walks the AST and collects references.
  const knownNodeIds = new Set(baseGraph.nodes.map((n) => n.id));
  const knownStateVars = new Set(Object.keys(initialState));
  for (const [updatedVar, expr] of Object.entries(recurrence.updates)) {
    if (!knownStateVars.has(updatedVar)) {
      throw new ValidationError(
        `stateTransition.recurrence.updates contains '${updatedVar}' which is not declared in initialState`
      );
    }
    checkRefs(expr, knownStateVars, knownNodeIds, `updates['${updatedVar}']`);
  }

  return {
    ...baseGraph,
    horizonSteps: g.horizonSteps,
    stateTransition: { initialState, recurrence },
    outputStateVar,
  };
}

function checkRefs(
  expr: RecurrenceExpr,
  states: Set<string>,
  nodes: Set<string>,
  path: string
): void {
  switch (expr.kind) {
    case "literal":
      return;
    case "state":
      if (!states.has(expr.name)) {
        throw new ValidationError(
          `Recurrence at ${path} references unknown state variable '${expr.name}'`
        );
      }
      return;
    case "sample":
      if (!nodes.has(expr.nodeId)) {
        throw new ValidationError(
          `Recurrence at ${path} references unknown node id '${expr.nodeId}'`
        );
      }
      return;
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "max":
    case "min":
      checkRefs(expr.left, states, nodes, `${path}.left`);
      checkRefs(expr.right, states, nodes, `${path}.right`);
      return;
    case "ifGreater":
      checkRefs(expr.left, states, nodes, `${path}.left`);
      checkRefs(expr.right, states, nodes, `${path}.right`);
      checkRefs(expr.then, states, nodes, `${path}.then`);
      checkRefs(expr.else, states, nodes, `${path}.else`);
      return;
  }
}
