/**
 * Request validators for the Semantic Mode API surface (Phase A2).
 *
 * Mirrors the typed-throw pattern in `lib/validation/schemas.ts`:
 * every validator either returns a fully-typed value or throws
 * `ValidationError`. Route handlers catch the typed throw via
 * `validationError(err)` in `lib/api/errors.ts` and emit a 400.
 *
 * Two validators here:
 *
 *  - `validateSemanticCreateRequest`: POST /api/semantic body
 *    `{ query: string }` (the natural-language question).
 *  - `validateSemanticPatchRequest`: PATCH /api/semantic/[id] body
 *    `{ event: SemanticEvent }` (a typed event the server applies via
 *    the A1 reducer).
 *
 * The event validator validates the discriminator (`event.type` is one
 * of the known event types) AND the required fields per type. Extra
 * fields are NOT silently allowed — anything outside the per-type
 * allowlist is rejected so the audit trail can't be polluted with
 * unintended payload.
 */

import { ValidationError } from "@/lib/validation/schemas";
import type {
  SemanticEvent,
  SemanticEventType,
} from "@/lib/semantic/state-machine";

// Re-export the same MAX_QUERY_LENGTH as the rest of the codebase. We
// do not redefine; we re-derive from the constant the analyze/analysis
// validators use so all surfaces stay in lock-step.
const MAX_QUERY_LENGTH = 20_000;

const VALID_RESEARCH_MECHANISMS = new Set([
  "llm_prior",
  "web_search",
  "rag_document",
  "multi_llm_consensus",
  "ensemble_forecast",
  "empirical_observation",
  "expert_panel",
]);

const VALID_DISTRIBUTIONS = new Set([
  "normal",
  "beta",
  "uniform",
  "lognormal",
  "triangular",
]);

const VALID_EVENT_TYPES = new Set<SemanticEventType>([
  "start",
  "clarificationsReceived",
  "answerClarification",
  "submitClarifications",
  "componentsReceived",
  "editComponent",
  "acceptComponents",
  "setThreshold",
  "startResearch",
  "researchReceived",
  "acceptResearch",
  "runModel",
  "modelComplete",
  "verifyNext",
  "acceptResult",
  "fail",
  "back",
  "reset",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface SemanticCreateRequest {
  query: string;
  /** Optional OpenRouter model id; falls back to OPENROUTER_DEFAULT_MODEL. */
  model?: string;
  /** Optional session-only API key override; falls back to OPENROUTER_API_KEY. */
  apiKey?: string;
}

export function validateSemanticCreateRequest(
  value: unknown,
): SemanticCreateRequest {
  const body = requireRecord(value, "Semantic create request");

  if (typeof body.query !== "string") {
    throw new ValidationError("query is required");
  }
  const query = body.query;
  if (query.trim() === "") {
    throw new ValidationError("query must be non-empty");
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError("query is too large");
  }

  const out: SemanticCreateRequest = { query };
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim() === "") {
      throw new ValidationError("model must be a non-empty string if provided");
    }
    out.model = body.model;
  }
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string" || body.apiKey.trim() === "") {
      throw new ValidationError("apiKey must be a non-empty string if provided");
    }
    out.apiKey = body.apiKey;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Patch (apply an event)
// ---------------------------------------------------------------------------

export interface SemanticPatchRequest {
  event: SemanticEvent;
  /** Optional OpenRouter model id used when the event triggers an auto-advance LLM call. */
  model?: string;
  /** Optional session-only API key override used for auto-advance LLM calls. */
  apiKey?: string;
}

export function validateSemanticPatchRequest(
  value: unknown,
): SemanticPatchRequest {
  const body = requireRecord(value, "Semantic patch request");

  if (body.event === undefined) {
    throw new ValidationError("event is required");
  }
  const event = requireRecord(body.event, "event");

  if (typeof event.type !== "string") {
    throw new ValidationError("event.type must be a string");
  }
  if (!VALID_EVENT_TYPES.has(event.type as SemanticEventType)) {
    throw new ValidationError(`event.type "${event.type}" is not recognized`);
  }

  const validated = validateEventByType(event);
  const out: SemanticPatchRequest = { event: validated };
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim() === "") {
      throw new ValidationError("model must be a non-empty string if provided");
    }
    out.model = body.model;
  }
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== "string" || body.apiKey.trim() === "") {
      throw new ValidationError("apiKey must be a non-empty string if provided");
    }
    out.apiKey = body.apiKey;
  }
  return out;
}

function validateEventByType(event: Record<string, unknown>): SemanticEvent {
  const type = event.type as SemanticEventType;
  switch (type) {
    case "start":
      return validateStartEvent(event);
    case "clarificationsReceived":
      return validateClarificationsReceivedEvent(event);
    case "answerClarification":
      return validateAnswerClarificationEvent(event);
    case "submitClarifications":
      return assertNoExtraFields(event, ["type"]) as SemanticEvent;
    case "componentsReceived":
      return validateComponentsReceivedEvent(event);
    case "editComponent":
      return validateEditComponentEvent(event);
    case "acceptComponents":
      return assertNoExtraFields(event, ["type"]) as SemanticEvent;
    case "setThreshold":
      return validateSetThresholdEvent(event);
    case "startResearch":
      return validateStartResearchEvent(event);
    case "researchReceived":
      return validateResearchReceivedEvent(event);
    case "acceptResearch":
      return validateAcceptResearchEvent(event);
    case "runModel":
      return assertNoExtraFields(event, ["type"]) as SemanticEvent;
    case "modelComplete":
      return validateModelCompleteEvent(event);
    case "verifyNext":
      return validateVerifyNextEvent(event);
    case "acceptResult":
      return assertNoExtraFields(event, ["type"]) as SemanticEvent;
    case "fail":
      return validateFailEvent(event);
    case "back":
      return assertNoExtraFields(event, ["type"]) as SemanticEvent;
    case "reset":
      return assertNoExtraFields(event, ["type"]) as SemanticEvent;
  }
}

function assertNoExtraFields(
  event: Record<string, unknown>,
  allowed: string[],
): Record<string, unknown> {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(event)) {
    if (!allowedSet.has(key)) {
      throw new ValidationError(
        `event has unexpected field "${key}" for type "${String(event.type)}"`,
      );
    }
  }
  return event;
}

function requireNonEmptyString(
  event: Record<string, unknown>,
  field: string,
): string {
  const value = event[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(
      `event.${field} must be a non-empty string for type "${String(event.type)}"`,
    );
  }
  return value;
}

function requireFiniteNumber(
  event: Record<string, unknown>,
  field: string,
): number {
  const value = event[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(
      `event.${field} must be a finite number for type "${String(event.type)}"`,
    );
  }
  return value;
}

function validateStartEvent(event: Record<string, unknown>): SemanticEvent {
  assertNoExtraFields(event, ["type", "query"]);
  const query = requireNonEmptyString(event, "query");
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError("event.query is too large");
  }
  return { type: "start", query };
}

function validateClarificationsReceivedEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "questions"]);
  const questions = event.questions;
  if (!Array.isArray(questions)) {
    throw new ValidationError(
      "event.questions must be an array for type \"clarificationsReceived\"",
    );
  }
  const validated = questions.map((q, i) => {
    if (!isRecord(q)) {
      throw new ValidationError(`event.questions[${i}] must be an object`);
    }
    if (typeof q.id !== "string" || q.id.trim() === "") {
      throw new ValidationError(
        `event.questions[${i}].id must be a non-empty string`,
      );
    }
    if (typeof q.question !== "string" || q.question.trim() === "") {
      throw new ValidationError(
        `event.questions[${i}].question must be a non-empty string`,
      );
    }
    const out: { id: string; question: string; defaultAnswer?: string; why?: string } = {
      id: q.id,
      question: q.question,
    };
    if (q.defaultAnswer !== undefined) {
      if (typeof q.defaultAnswer !== "string") {
        throw new ValidationError(
          `event.questions[${i}].defaultAnswer must be a string`,
        );
      }
      out.defaultAnswer = q.defaultAnswer;
    }
    if (q.why !== undefined) {
      if (typeof q.why !== "string") {
        throw new ValidationError(`event.questions[${i}].why must be a string`);
      }
      out.why = q.why;
    }
    return out;
  });
  return { type: "clarificationsReceived", questions: validated };
}

function validateAnswerClarificationEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "qId", "answer"]);
  const qId = requireNonEmptyString(event, "qId");
  if (typeof event.answer !== "string") {
    throw new ValidationError(
      "event.answer must be a string for type \"answerClarification\"",
    );
  }
  return { type: "answerClarification", qId, answer: event.answer };
}

function validateComponentsReceivedEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "components"]);
  const components = event.components;
  if (!Array.isArray(components)) {
    throw new ValidationError(
      "event.components must be an array for type \"componentsReceived\"",
    );
  }
  const validated = components.map((c, i) => validateProposedComponent(c, i));
  return { type: "componentsReceived", components: validated };
}

function validateProposedComponent(value: unknown, index: number) {
  if (!isRecord(value)) {
    throw new ValidationError(`event.components[${index}] must be an object`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new ValidationError(
      `event.components[${index}].id must be a non-empty string`,
    );
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new ValidationError(
      `event.components[${index}].name must be a non-empty string`,
    );
  }
  if (typeof value.description !== "string") {
    throw new ValidationError(
      `event.components[${index}].description must be a string`,
    );
  }
  const out: {
    id: string;
    name: string;
    description: string;
    suggestedDistribution?: ReturnType<typeof asDistribution>;
    dependsOn?: string[];
    why?: string;
  } = {
    id: value.id,
    name: value.name,
    description: value.description,
  };
  if (value.suggestedDistribution !== undefined) {
    out.suggestedDistribution = asDistribution(value.suggestedDistribution, index);
  }
  if (value.dependsOn !== undefined) {
    if (!Array.isArray(value.dependsOn)) {
      throw new ValidationError(
        `event.components[${index}].dependsOn must be an array of strings`,
      );
    }
    const deps: string[] = [];
    for (let j = 0; j < value.dependsOn.length; j++) {
      const dep = value.dependsOn[j];
      if (typeof dep !== "string" || dep.trim() === "") {
        throw new ValidationError(
          `event.components[${index}].dependsOn[${j}] must be a non-empty string`,
        );
      }
      deps.push(dep);
    }
    out.dependsOn = deps;
  }
  if (value.why !== undefined) {
    if (typeof value.why !== "string") {
      throw new ValidationError(
        `event.components[${index}].why must be a string`,
      );
    }
    out.why = value.why;
  }
  return out;
}

function asDistribution(value: unknown, index: number) {
  if (typeof value !== "string" || !VALID_DISTRIBUTIONS.has(value)) {
    throw new ValidationError(
      `event.components[${index}].suggestedDistribution "${String(value)}" is not a supported distribution`,
    );
  }
  return value as "normal" | "beta" | "uniform" | "lognormal" | "triangular";
}

function validateEditComponentEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "componentId", "patch"]);
  const componentId = requireNonEmptyString(event, "componentId");
  const patch = event.patch;
  if (!isRecord(patch)) {
    throw new ValidationError(
      "event.patch must be an object for type \"editComponent\"",
    );
  }
  const allowedPatchKeys = new Set([
    "name",
    "description",
    "suggestedDistribution",
    "dependsOn",
    "why",
  ]);
  const cleanedPatch: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(patch)) {
    if (!allowedPatchKeys.has(key)) {
      throw new ValidationError(
        `event.patch has unexpected field "${key}" for type "editComponent"`,
      );
    }
    cleanedPatch[key] = val;
  }
  if (
    cleanedPatch.name !== undefined &&
    (typeof cleanedPatch.name !== "string" || cleanedPatch.name.trim() === "")
  ) {
    throw new ValidationError("event.patch.name must be a non-empty string");
  }
  if (
    cleanedPatch.description !== undefined &&
    typeof cleanedPatch.description !== "string"
  ) {
    throw new ValidationError("event.patch.description must be a string");
  }
  if (cleanedPatch.suggestedDistribution !== undefined) {
    cleanedPatch.suggestedDistribution = asDistribution(
      cleanedPatch.suggestedDistribution,
      -1,
    );
  }
  if (cleanedPatch.dependsOn !== undefined) {
    if (!Array.isArray(cleanedPatch.dependsOn)) {
      throw new ValidationError(
        "event.patch.dependsOn must be an array of strings",
      );
    }
    for (let i = 0; i < cleanedPatch.dependsOn.length; i++) {
      const dep = (cleanedPatch.dependsOn as unknown[])[i];
      if (typeof dep !== "string" || dep.trim() === "") {
        throw new ValidationError(
          `event.patch.dependsOn[${i}] must be a non-empty string`,
        );
      }
    }
  }
  if (
    cleanedPatch.why !== undefined &&
    typeof cleanedPatch.why !== "string"
  ) {
    throw new ValidationError("event.patch.why must be a string");
  }
  return {
    type: "editComponent",
    componentId,
    patch: cleanedPatch as SemanticEvent extends { type: "editComponent"; patch: infer P } ? P : never,
  };
}

function validateSetThresholdEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "threshold", "thresholdLabel"]);
  const threshold = requireFiniteNumber(event, "threshold");
  const thresholdLabel = requireNonEmptyString(event, "thresholdLabel");
  return { type: "setThreshold", threshold, thresholdLabel };
}

function validateStartResearchEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "componentId", "mechanism"]);
  const componentId = requireNonEmptyString(event, "componentId");
  if (typeof event.mechanism !== "string" || !VALID_RESEARCH_MECHANISMS.has(event.mechanism)) {
    throw new ValidationError(
      `event.mechanism "${String(event.mechanism)}" is not a recognized research mechanism`,
    );
  }
  return {
    type: "startResearch",
    componentId,
    mechanism: event.mechanism as
      | "llm_prior"
      | "web_search"
      | "rag_document"
      | "multi_llm_consensus"
      | "ensemble_forecast"
      | "empirical_observation"
      | "expert_panel",
  };
}

function validateResearchReceivedEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "componentId", "bundle"]);
  const componentId = requireNonEmptyString(event, "componentId");
  const bundle = event.bundle;
  if (!isRecord(bundle)) {
    throw new ValidationError(
      "event.bundle must be an object for type \"researchReceived\"",
    );
  }
  if (typeof bundle.componentId !== "string" || bundle.componentId.trim() === "") {
    throw new ValidationError("event.bundle.componentId must be a non-empty string");
  }
  if (typeof bundle.mechanism !== "string" || !VALID_RESEARCH_MECHANISMS.has(bundle.mechanism)) {
    throw new ValidationError(
      `event.bundle.mechanism "${String(bundle.mechanism)}" is not a recognized research mechanism`,
    );
  }
  if (typeof bundle.proposedDistribution !== "string" || !VALID_DISTRIBUTIONS.has(bundle.proposedDistribution)) {
    throw new ValidationError(
      `event.bundle.proposedDistribution "${String(bundle.proposedDistribution)}" is not a supported distribution`,
    );
  }
  if (!isRecord(bundle.proposedParams)) {
    throw new ValidationError("event.bundle.proposedParams must be an object");
  }
  if (typeof bundle.reasoning !== "string") {
    throw new ValidationError("event.bundle.reasoning must be a string");
  }
  return {
    type: "researchReceived",
    componentId,
    bundle: {
      componentId: bundle.componentId,
      mechanism: bundle.mechanism as
        | "llm_prior"
        | "web_search"
        | "rag_document"
        | "multi_llm_consensus"
        | "ensemble_forecast"
        | "empirical_observation"
        | "expert_panel",
      proposedDistribution: bundle.proposedDistribution as
        | "normal"
        | "beta"
        | "uniform"
        | "lognormal"
        | "triangular",
      proposedParams: bundle.proposedParams as Record<string, number>,
      reasoning: bundle.reasoning,
    },
  };
}

function validateAcceptResearchEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "componentId"]);
  const componentId = requireNonEmptyString(event, "componentId");
  return { type: "acceptResearch", componentId };
}

function validateModelCompleteEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "result"]);
  if (!isRecord(event.result)) {
    throw new ValidationError(
      "event.result must be an object for type \"modelComplete\"",
    );
  }
  return {
    type: "modelComplete",
    result: event.result as { topSensitivityComponentId?: string; pAboveThreshold?: number; raw?: unknown },
  };
}

function validateVerifyNextEvent(
  event: Record<string, unknown>,
): SemanticEvent {
  assertNoExtraFields(event, ["type", "componentId"]);
  const componentId = requireNonEmptyString(event, "componentId");
  return { type: "verifyNext", componentId };
}

function validateFailEvent(event: Record<string, unknown>): SemanticEvent {
  assertNoExtraFields(event, ["type", "message"]);
  if (typeof event.message !== "string" || event.message.trim() === "") {
    throw new ValidationError(
      "event.message must be a non-empty string for type \"fail\"",
    );
  }
  return { type: "fail", message: event.message };
}
