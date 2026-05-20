/**
 * Typed fetch wrappers over the Semantic Mode API surface (Phase A5).
 *
 * Every UI component dispatches state-machine events through these
 * functions — NEVER calls raw fetch. The wrappers translate API status
 * codes into typed errors so the panel can route them to the
 * appropriate UI affordance (banner vs back button vs restart vs
 * developer-only console message).
 *
 * Error mapping (per the contract in `app/api/semantic/[id]/route.ts`):
 *
 *   400 -> SemanticValidationError   (request body was malformed)
 *   401 -> SemanticAuthError         (not authenticated)
 *   404 -> SemanticNotFoundError     (conversation missing or cross-owner)
 *   422 -> SemanticReducerError      (state-machine illegal-event)
 *   other -> SemanticNetworkError    (5xx / fetch failure / non-JSON body)
 *
 * Network failures (no response, JSON parse failure) also map to
 * SemanticNetworkError so callers never see a raw `TypeError` from
 * fetch.
 *
 * No raw `query` text is ever logged from this module; the URL paths
 * and method names are the only identifying breadcrumbs the browser
 * surfaces.
 */
import type {
  PersistedSemanticConversation,
} from "@/lib/semantic/persistence";
import type {
  SemanticEvent,
  StartResearchInputs,
} from "@/lib/semantic/state-machine";
import type { ResearchMechanism } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SemanticApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "SemanticApiError";
    this.status = status;
    this.code = code;
  }
}

export class SemanticValidationError extends SemanticApiError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "SemanticValidationError";
  }
}

export class SemanticAuthError extends SemanticApiError {
  constructor(message: string) {
    super(message, 401, "UNAUTHENTICATED");
    this.name = "SemanticAuthError";
  }
}

export class SemanticNotFoundError extends SemanticApiError {
  constructor(message: string) {
    super(message, 404, "NOT_FOUND");
    this.name = "SemanticNotFoundError";
  }
}

/**
 * The server's reducer threw `SemanticStateError` — the client tried to
 * dispatch an event that the current state does not support. Surfaces
 * to the UI as a recoverable "this step is no longer valid; go back or
 * start over" notice rather than a hard failure.
 */
export class SemanticReducerError extends SemanticApiError {
  constructor(message: string) {
    super(message, 422, "UNPROCESSABLE_ENTITY");
    this.name = "SemanticReducerError";
  }
}

export class SemanticNetworkError extends SemanticApiError {
  constructor(message: string, status = 0) {
    super(message, status, "NETWORK_ERROR");
    this.name = "SemanticNetworkError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractErrorMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body
  ) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") return err;
    if (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
  }
  return fallback;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function throwForStatus(status: number, message: string): never {
  switch (status) {
    case 400:
      throw new SemanticValidationError(message);
    case 401:
      throw new SemanticAuthError(message);
    case 404:
      throw new SemanticNotFoundError(message);
    case 422:
      throw new SemanticReducerError(message);
    default:
      throw new SemanticNetworkError(message, status);
  }
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      credentials: "include",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "network failure";
    throw new SemanticNetworkError(`Network request failed: ${detail}`);
  }

  if (!response.ok) {
    const body = await safeJson(response);
    const message = extractErrorMessage(
      body,
      `Request failed with status ${response.status}`,
    );
    throwForStatus(response.status, message);
  }

  const body = await safeJson(response);
  if (body === null) {
    throw new SemanticNetworkError(
      "Server response was not valid JSON",
      response.status,
    );
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * POST /api/semantic — create a new semantic conversation from a query.
 * The server immediately advances to CLARIFYING.
 */
export async function createConversation(
  query: string,
): Promise<PersistedSemanticConversation> {
  return request<PersistedSemanticConversation>("/api/semantic", {
    method: "POST",
    body: JSON.stringify({ query }),
  });
}

/**
 * GET /api/semantic — list the requester's saved semantic conversations.
 */
export async function listConversations(): Promise<{
  conversations: PersistedSemanticConversation[];
}> {
  return request<{ conversations: PersistedSemanticConversation[] }>(
    "/api/semantic",
    { method: "GET" },
  );
}

/**
 * GET /api/semantic/[id] — load a single conversation by id.
 */
export async function loadConversation(
  id: string,
): Promise<PersistedSemanticConversation> {
  return request<PersistedSemanticConversation>(
    `/api/semantic/${encodeURIComponent(id)}`,
    { method: "GET" },
  );
}

/**
 * PATCH /api/semantic/[id] — dispatch a typed state-machine event.
 * The server validates the event shape, applies the A1 reducer, and
 * returns the new state. SemanticReducerError signals an illegal-event
 * (the UI typically routes that to a "back" or "restart" affordance).
 */
export async function dispatchEvent(
  id: string,
  event: SemanticEvent,
): Promise<PersistedSemanticConversation> {
  return request<PersistedSemanticConversation>(
    `/api/semantic/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ event }),
    },
  );
}

/**
 * B6 helper: dispatch a `startResearch` event with typed mechanism +
 * optional mechanism-specific inputs (CSV rows, expert estimates,
 * search query, etc.). Thin wrapper over `dispatchEvent` that exists so
 * call sites (the ResearchStep UI) get explicit typing of `inputs` per
 * `StartResearchInputs`. The server fires the appropriate adapter
 * immediately and applies `researchReceived` (or `fail`) before
 * returning the updated conversation.
 */
export async function startResearch(
  id: string,
  componentId: string,
  mechanism: ResearchMechanism,
  inputs?: StartResearchInputs,
): Promise<PersistedSemanticConversation> {
  const event: SemanticEvent =
    inputs && Object.keys(inputs).length > 0
      ? { type: "startResearch", componentId, mechanism, inputs }
      : { type: "startResearch", componentId, mechanism };
  return dispatchEvent(id, event);
}

/**
 * DELETE /api/semantic/[id] — hard-delete the conversation row.
 */
export async function deleteConversation(
  id: string,
): Promise<{ success: true }> {
  return request<{ success: true }>(
    `/api/semantic/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
