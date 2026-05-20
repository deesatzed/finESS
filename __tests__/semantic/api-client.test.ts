/**
 * Semantic Mode A5 — typed API-client unit tests.
 *
 * Every fetch mock here is a TEST-HARNESS fake to exercise status-code
 * to typed-error mapping and request shaping. No product code path
 * consumes them. The production client calls the real /api/semantic
 * routes; the route handlers themselves are tested under __tests__/api.
 */
import {
  createConversation,
  dispatchEvent,
  deleteConversation,
  listConversations,
  loadConversation,
  SemanticApiError,
  SemanticAuthError,
  SemanticNetworkError,
  SemanticNotFoundError,
  SemanticReducerError,
  SemanticValidationError,
} from "@/lib/semantic/api-client";
import type { PersistedSemanticConversation } from "@/lib/semantic/persistence";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function nonJsonResponse(status = 500): Response {
  return new Response("not json at all", {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function makeFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return jest.fn(impl);
}

const HAPPY_CONVERSATION: PersistedSemanticConversation = {
  id: "conv-1",
  userId: "user-1",
  workspaceId: "ws-1",
  query: "test",
  state: { kind: "CLARIFYING", query: "test" },
  createdAt: "2026-05-20T00:00:00.000Z",
  updatedAt: "2026-05-20T00:00:00.000Z",
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// createConversation
// ---------------------------------------------------------------------------

describe("createConversation", () => {
  it("POSTs JSON body and returns the parsed conversation on 201", async () => {
    const fetchMock = makeFetch(async (url, init) => {
      expect(url).toBe("/api/semantic");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ query: "hello" });
      return jsonResponse(HAPPY_CONVERSATION, { status: 201 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await createConversation("hello");
    expect(out.id).toBe("conv-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 400 to SemanticValidationError with the server message", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse(
        { error: { code: "VALIDATION_ERROR", message: "query is required" } },
        { status: 400 },
      ),
    ) as unknown as typeof fetch;

    await expect(createConversation("")).rejects.toBeInstanceOf(
      SemanticValidationError,
    );
    await expect(createConversation("")).rejects.toThrow("query is required");
  });

  it("maps a 401 to SemanticAuthError", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse(
        { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
        { status: 401 },
      ),
    ) as unknown as typeof fetch;

    await expect(createConversation("hi")).rejects.toBeInstanceOf(SemanticAuthError);
  });
});

// ---------------------------------------------------------------------------
// listConversations / loadConversation / deleteConversation
// ---------------------------------------------------------------------------

describe("listConversations", () => {
  it("returns the parsed conversations array", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse({ conversations: [HAPPY_CONVERSATION] }),
    ) as unknown as typeof fetch;

    const out = await listConversations();
    expect(out.conversations.length).toBe(1);
    expect(out.conversations[0].id).toBe("conv-1");
  });
});

describe("loadConversation", () => {
  it("encodes the id into the URL", async () => {
    const fetchMock = makeFetch(async (url) => {
      expect(url).toBe("/api/semantic/conv%201%2F2");
      return jsonResponse(HAPPY_CONVERSATION);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await loadConversation("conv 1/2");
    expect(out.id).toBe("conv-1");
  });

  it("maps a 404 to SemanticNotFoundError", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse(
        { error: { code: "NOT_FOUND", message: "Conversation not found" } },
        { status: 404 },
      ),
    ) as unknown as typeof fetch;

    await expect(loadConversation("missing")).rejects.toBeInstanceOf(
      SemanticNotFoundError,
    );
  });
});

describe("deleteConversation", () => {
  it("sends a DELETE and returns the success body", async () => {
    const fetchMock = makeFetch(async (url, init) => {
      expect(url).toBe("/api/semantic/abc");
      expect(init?.method).toBe("DELETE");
      return jsonResponse({ success: true });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await deleteConversation("abc");
    expect(out.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dispatchEvent
// ---------------------------------------------------------------------------

describe("dispatchEvent", () => {
  it("PATCHes the event body and returns the updated conversation", async () => {
    const fetchMock = makeFetch(async (url, init) => {
      expect(url).toBe("/api/semantic/conv-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        event: { type: "submitClarifications" },
      });
      return jsonResponse({
        ...HAPPY_CONVERSATION,
        state: {
          kind: "PROPOSING_COMPONENTS",
          query: "test",
          questions: [],
          answers: {},
        },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const updated = await dispatchEvent("conv-1", {
      type: "submitClarifications",
    });
    expect(updated.state.kind).toBe("PROPOSING_COMPONENTS");
  });

  it("maps a 422 to SemanticReducerError with the reducer's message", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse(
        {
          error: {
            code: "UNPROCESSABLE_ENTITY",
            message:
              'SemanticStateError: cannot apply event "runModel" in state "IDLE": no transition defined',
          },
        },
        { status: 422 },
      ),
    ) as unknown as typeof fetch;

    await expect(
      dispatchEvent("conv-1", { type: "runModel" }),
    ).rejects.toBeInstanceOf(SemanticReducerError);
    await expect(
      dispatchEvent("conv-1", { type: "runModel" }),
    ).rejects.toThrow(/cannot apply event "runModel"/);
  });

  it("maps any other 5xx to SemanticNetworkError with the status carried", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse({ error: { message: "boom" } }, { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      dispatchEvent("conv-1", { type: "submitClarifications" }),
    ).rejects.toMatchObject({
      name: "SemanticNetworkError",
      status: 503,
    });
  });
});

// ---------------------------------------------------------------------------
// Network and JSON failure modes
// ---------------------------------------------------------------------------

describe("network / parse failures", () => {
  it("wraps a fetch throw in SemanticNetworkError", async () => {
    global.fetch = makeFetch(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(listConversations()).rejects.toBeInstanceOf(
      SemanticNetworkError,
    );
  });

  it("treats a 2xx with non-JSON body as SemanticNetworkError", async () => {
    global.fetch = makeFetch(async () => nonJsonResponse(200)) as unknown as typeof fetch;
    await expect(listConversations()).rejects.toMatchObject({
      name: "SemanticNetworkError",
      status: 200,
    });
  });

  it("falls back to a status-message error when the body is missing 'error'", async () => {
    global.fetch = makeFetch(async () =>
      jsonResponse({}, { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      dispatchEvent("conv-1", { type: "submitClarifications" }),
    ).rejects.toMatchObject({
      name: "SemanticValidationError",
      message: "Request failed with status 400",
    });
  });
});

// ---------------------------------------------------------------------------
// Error class shape
// ---------------------------------------------------------------------------

describe("error classes", () => {
  it("SemanticApiError is the base; subclasses inherit", () => {
    expect(new SemanticValidationError("x")).toBeInstanceOf(SemanticApiError);
    expect(new SemanticAuthError("x")).toBeInstanceOf(SemanticApiError);
    expect(new SemanticNotFoundError("x")).toBeInstanceOf(SemanticApiError);
    expect(new SemanticReducerError("x")).toBeInstanceOf(SemanticApiError);
    expect(new SemanticNetworkError("x")).toBeInstanceOf(SemanticApiError);
  });

  it("preserves code and status fields", () => {
    const e = new SemanticReducerError("nope");
    expect(e.code).toBe("UNPROCESSABLE_ENTITY");
    expect(e.status).toBe(422);
  });
});
