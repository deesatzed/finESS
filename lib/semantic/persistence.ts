/**
 * Persistence layer for Semantic Mode conversations (Phase A2).
 *
 * The state machine in `./state-machine.ts` is a pure reducer over a
 * discriminated union (`SemanticState`). This module is responsible for
 * round-tripping that union through SQLite as a JSON blob.
 *
 * Design notes:
 *
 *  1. The live state shape in A1 uses plain object maps
 *     (`Record<string, ResearchMechanism>` for `inFlight`,
 *     `Record<string, true>` for `accepted`) rather than `Set<string>`,
 *     so JSON.stringify on the state preserves them faithfully. A naive
 *     `JSON.stringify` would round-trip correctly today.
 *
 *     However, the realignment plan calls Sets out as a load-bearing risk
 *     ("JSON.stringify on a Set produces {}"). To future-proof against
 *     someone refactoring `inFlight` or `accepted` to actual Sets later,
 *     `serializeState` walks the state and converts any Set instances to
 *     plain arrays under a sentinel envelope, and `deserializeState`
 *     reverses it. The round-trip is therefore Set-safe even if a future
 *     refactor reintroduces Sets.
 *
 *  2. `ERROR` states are recursive: `ERROR.sourceState` is itself a
 *     SemanticState. Both serializer and deserializer recurse into
 *     `sourceState` so an ERROR wrapping a REVIEWING_RESEARCH state
 *     (with accepted bundles) survives a full round trip.
 *
 *  3. Deserialization validates the `kind` discriminator against the
 *     known SemanticState union; unknown kinds throw with a clear
 *     message. The JSON parse step is wrapped so syntactically invalid
 *     payloads also throw with a clear message rather than dumping a
 *     raw `SyntaxError`.
 */

import type { SemanticState, SemanticStateKind } from "./state-machine";

// ---------------------------------------------------------------------------
// Persisted shape (what callers see)
// ---------------------------------------------------------------------------

/**
 * What the API hands back to the client: the live SemanticState already
 * hydrated, plus the row metadata. `createdAt` / `updatedAt` are ISO
 * strings (the API serializes the Prisma Date objects to JSON).
 */
export interface PersistedSemanticConversation {
  id: string;
  userId: string;
  workspaceId: string;
  query: string;
  state: SemanticState;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SemanticPersistenceError extends Error {
  constructor(message: string) {
    super(`SemanticPersistenceError: ${message}`);
    this.name = "SemanticPersistenceError";
  }
}

// ---------------------------------------------------------------------------
// Allowed state kinds — kept in sync with state-machine's SemanticState
// ---------------------------------------------------------------------------

const ALLOWED_STATE_KINDS = new Set<SemanticStateKind>([
  "IDLE",
  "CLARIFYING",
  "AWAITING_ANSWERS",
  "PROPOSING_COMPONENTS",
  "REVIEWING_COMPONENTS",
  "SETTING_THRESHOLD",
  "RESEARCHING",
  "REVIEWING_RESEARCH",
  "MODELING",
  "REVIEWING_RESULT",
  "COMPLETE",
  "ERROR",
]);

// Sentinel used to round-trip Set instances through JSON. The sentinel
// is intentionally namespaced so it cannot collide with payload fields
// that happen to contain "__set__" as a key.
const SET_SENTINEL = "__semantic_set__";

interface SetEnvelope {
  [SET_SENTINEL]: true;
  values: unknown[];
}

function isSetEnvelope(value: unknown): value is SetEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[SET_SENTINEL] === true &&
    Array.isArray((value as Record<string, unknown>).values)
  );
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Serialize a SemanticState to a JSON string suitable for storing in the
 * SemanticConversation.stateJson column.
 *
 * Sets (if any are present anywhere in the state graph) are converted
 * to a `{__semantic_set__: true, values: [...]}` envelope so they round
 * trip through JSON. Plain objects, arrays, primitives, and nulls are
 * preserved verbatim.
 *
 * Throws SemanticPersistenceError if the input is not a recognized
 * SemanticState shape (unknown discriminator).
 */
export function serializeState(state: SemanticState): string {
  if (!isPlausibleState(state)) {
    throw new SemanticPersistenceError(
      `cannot serialize: state.kind "${(state as { kind?: string }).kind}" is not a known SemanticState kind`,
    );
  }
  const encoded = encodeSets(state);
  try {
    return JSON.stringify(encoded);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SemanticPersistenceError(`JSON.stringify failed: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

/**
 * Deserialize a JSON string (as produced by `serializeState`) back into a
 * live SemanticState. Inverts the Set-envelope conversion.
 *
 * Throws SemanticPersistenceError when:
 *  - the JSON is syntactically invalid
 *  - the parsed value is not an object
 *  - the object's `kind` is not a known SemanticState discriminator
 *  - an ERROR state's nested `sourceState` is not itself a valid state
 */
export function deserializeState(json: string): SemanticState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SemanticPersistenceError(
      `cannot deserialize: invalid JSON (${detail})`,
    );
  }

  const decoded = decodeSets(parsed);
  if (!isPlausibleState(decoded)) {
    const kind =
      typeof decoded === "object" && decoded !== null
        ? (decoded as { kind?: unknown }).kind
        : decoded;
    throw new SemanticPersistenceError(
      `cannot deserialize: state.kind "${String(kind)}" is not a known SemanticState kind`,
    );
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff `value` looks like a plausible SemanticState — an
 * object with a `kind` field whose value is in the allowed set. This
 * is a structural sanity check, not a deep validation: the state
 * machine itself is the only source of truth for legal transitions.
 *
 * For ERROR states, also recursively checks that `sourceState` is
 * plausibly a SemanticState.
 */
function isPlausibleState(value: unknown): value is SemanticState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string") return false;
  if (!ALLOWED_STATE_KINDS.has(kind as SemanticStateKind)) return false;
  if (kind === "ERROR") {
    const source = (value as { sourceState?: unknown }).sourceState;
    if (!isPlausibleState(source)) return false;
  }
  return true;
}

/**
 * Walk an arbitrary value, converting any Set instances into the
 * sentinel envelope. Pure: never mutates the input.
 */
function encodeSets(value: unknown): unknown {
  if (value instanceof Set) {
    const envelope: SetEnvelope = {
      [SET_SENTINEL]: true,
      values: Array.from(value as Set<unknown>).map(encodeSets),
    };
    return envelope;
  }
  if (Array.isArray(value)) {
    return value.map(encodeSets);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeSets(v);
    }
    return out;
  }
  return value;
}

/**
 * Walk an arbitrary value, converting any sentinel envelopes back into
 * Set instances. Pure: never mutates the input.
 */
function decodeSets(value: unknown): unknown {
  if (isSetEnvelope(value)) {
    return new Set(value.values.map(decodeSets));
  }
  if (Array.isArray(value)) {
    return value.map(decodeSets);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decodeSets(v);
    }
    return out;
  }
  return value;
}
