/**
 * Semantic Mode B4 — multi-LLM consensus unit tests.
 *
 * NOTE on fetch fakes: every `fetchFake` below is a TEST-HARNESS FAKE
 * used only to observe `researchConsensus` behaviour in isolation
 * (per-model success/failure, ordering, envelope synthesis,
 * concurrency bounding). They are NOT product mock data — no product
 * code path consumes them. The production surface still calls the real
 * OpenRouter endpoint through `callChat`; see the gated live
 * integration test for the real-network proof.
 */

import {
  researchConsensus,
  ConsensusResearchError,
} from "@/lib/semantic/research/consensus";
import type {
  ProposedComponent,
  SemanticDistribution,
} from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPONENT: ProposedComponent = {
  id: "growth_rate",
  name: "Monthly MRR growth rate",
  description: "Percent month-over-month MRR growth.",
  suggestedDistribution: "normal",
  why: "Drives the answer's exponential trajectory.",
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface BundlePayload {
  proposedDistribution: SemanticDistribution;
  proposedParams: Record<string, number>;
  reasoning: string;
}

function chatBody(payload: BundlePayload, cost = 0.001, model = "test/echo") {
  return {
    model,
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { cost },
  };
}

/**
 * Build a fetch fake that returns one labelled response per model id
 * present in the request body. Allows per-model customization of
 * payload, cost, and an optional injected error (rejection / non-200).
 */
interface PerModelSpec {
  payload?: BundlePayload;
  cost?: number;
  status?: number;
  /** If set, the fetch fake rejects with this error instead of resolving. */
  reject?: Error;
  /** If set, the fetch fake's resolved content is this raw string. */
  rawContent?: string;
  /** Optional delay (ms) before resolution — for concurrency tests. */
  delayMs?: number;
}

function buildLabelledFetch(
  perModel: Record<string, PerModelSpec>,
  observer?: (modelId: string) => void,
) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const modelId: string = body.model;
    const spec = perModel[modelId] ?? {};
    if (observer) observer(modelId);
    if (spec.delayMs) {
      await new Promise((r) => setTimeout(r, spec.delayMs));
    }
    if (spec.reject) throw spec.reject;
    if (spec.status && spec.status >= 400) {
      return new Response(JSON.stringify({ error: "boom" }), {
        status: spec.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (spec.rawContent !== undefined) {
      const raw = {
        model: modelId,
        choices: [{ message: { content: spec.rawContent } }],
        usage: { cost: spec.cost ?? 0.001 },
      };
      return jsonResponse(raw);
    }
    if (!spec.payload) {
      // Default-empty bundle is a programmer error in the test
      throw new Error(
        `test-harness misconfigured: no spec for model "${modelId}"`,
      );
    }
    return jsonResponse(chatBody(spec.payload, spec.cost ?? 0.001, modelId));
  };
}

// Canonical payloads ---------------------------------------------------------

function normalPayload(mean: number, sd: number, why = "rationale"): BundlePayload {
  return {
    proposedDistribution: "normal",
    proposedParams: { mean, sd },
    reasoning: why,
  };
}

function betaPayload(alpha: number, beta: number, why = "rationale"): BundlePayload {
  return {
    proposedDistribution: "beta",
    proposedParams: { alpha, beta },
    reasoning: why,
  };
}

function triangularPayload(
  min: number,
  mode: number,
  max: number,
  why = "rationale",
): BundlePayload {
  return {
    proposedDistribution: "triangular",
    proposedParams: { min, mode, max },
    reasoning: why,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("researchConsensus — input validation", () => {
  test("EMPTY_MODELS when called with zero models", async () => {
    await expect(
      researchConsensus({
        component: COMPONENT,
        query: "q",
        models: [],
        apiKey: "sk-test",
      }),
    ).rejects.toMatchObject({
      name: "ConsensusResearchError",
      code: "EMPTY_MODELS",
    });
  });

  test("EMPTY_MODELS when called with a single model", async () => {
    await expect(
      researchConsensus({
        component: COMPONENT,
        query: "q",
        models: ["solo/one"],
        apiKey: "sk-test",
      }),
    ).rejects.toMatchObject({
      name: "ConsensusResearchError",
      code: "EMPTY_MODELS",
    });
  });
});

describe("researchConsensus — happy paths", () => {
  test("all 3 proposers succeed with same distribution + same params → disagreementScore = 0", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(10, 2, "A reasons"), cost: 0.002 },
        "vendor/b": { payload: normalPayload(10, 2, "B reasons"), cost: 0.003 },
        "vendor/c": { payload: normalPayload(10, 2, "C reasons"), cost: 0.004 },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "what is the growth rate?",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.successCount).toBe(3);
    expect(result.errorCount).toBe(0);
    expect(result.proposals.map((p) => p.model)).toEqual([
      "vendor/a",
      "vendor/b",
      "vendor/c",
    ]);
    expect(result.consensus).not.toBeNull();
    expect(result.consensus!.mechanism).toBe("multi_llm_consensus");
    expect(result.consensus!.proposedDistribution).toBe("normal");
    expect(result.consensus!.proposedParams.mean).toBe(10);
    expect(result.consensus!.proposedParams.sd).toBe(2);
    expect(result.disagreementScore).toBe(0);
    expect(result.totalCostUsd).toBeCloseTo(0.009, 6);
  });

  test("all proposers same family, different params → consensus widens envelope", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(8, 1.5) },
        "vendor/b": { payload: normalPayload(10, 2.0) },
        "vendor/c": { payload: normalPayload(12, 2.5) },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.successCount).toBe(3);
    // mean = mean-of-means = 10, sd = max-of-sds = 2.5
    expect(result.consensus!.proposedParams.mean).toBeCloseTo(10, 6);
    expect(result.consensus!.proposedParams.sd).toBe(2.5);
    // central-estimate spread = 12-8 = 4 over max(|12|, |8|) = 12 → 0.333...
    expect(result.disagreementScore).toBeCloseTo(4 / 12, 6);
  });

  test("majority vote: 2 normal vs 1 beta → consensus uses normal", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(5, 1) },
        "vendor/b": { payload: normalPayload(7, 1.2) },
        "vendor/c": { payload: betaPayload(2, 5) },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.consensus!.proposedDistribution).toBe("normal");
    expect(result.consensus!.proposedParams.mean).toBeCloseTo(6, 6);
    expect(result.consensus!.proposedParams.sd).toBe(1.2);
  });
});

describe("researchConsensus — failure handling", () => {
  test("one proposer fails (HTTP 401), others succeed → batch survives", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(9, 1) },
        "vendor/b": { status: 401 },
        "vendor/c": { payload: normalPayload(11, 1) },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.successCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.proposals[1].bundle).toBeUndefined();
    expect(result.proposals[1].error).toMatch(/HTTP_ERROR|401/);
    expect(result.consensus).not.toBeNull();
    expect(result.consensus!.proposedDistribution).toBe("normal");
    expect(result.consensus!.proposedParams.mean).toBeCloseTo(10, 6);
  });

  test("all proposers fail → ALL_PROPOSERS_FAILED thrown", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { status: 500 },
        "vendor/b": { status: 401 },
      }),
    );

    await expect(
      researchConsensus({
        component: COMPONENT,
        query: "q",
        models: ["vendor/a", "vendor/b"],
        apiKey: "sk-test",
        fetchImpl: fetchFake as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "ConsensusResearchError",
      code: "ALL_PROPOSERS_FAILED",
    });
  });

  test("invalid JSON from one proposer is captured as PARSE_FAILED", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(5, 1) },
        "vendor/b": { rawContent: "not json at all" },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.successCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.proposals[1].error).toMatch(/PARSE_FAILED/);
  });

  test("invalid distribution from one proposer is captured as INVALID_DISTRIBUTION", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(5, 1) },
        "vendor/b": {
          rawContent: JSON.stringify({
            proposedDistribution: "bayesian",
            proposedParams: { mean: 0 },
            reasoning: "x",
          }),
        },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.proposals[1].error).toMatch(/INVALID_DISTRIBUTION/);
    expect(result.proposals[1].error).toMatch(/bayesian/);
  });
});

describe("researchConsensus — single survivor", () => {
  test("only one successful proposer → consensus = that bundle verbatim, disagreementScore = 0", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(7, 1.4, "the only voice") },
        "vendor/b": { status: 503 },
        "vendor/c": { status: 502 },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.successCount).toBe(1);
    expect(result.consensus!.proposedDistribution).toBe("normal");
    expect(result.consensus!.proposedParams.mean).toBe(7);
    expect(result.consensus!.proposedParams.sd).toBe(1.4);
    expect(result.consensus!.mechanism).toBe("multi_llm_consensus");
    expect(result.consensus!.reasoning).toMatch(/1 successful proposer/);
    expect(result.disagreementScore).toBe(0);
  });
});

describe("researchConsensus — concurrency", () => {
  test("concurrencyLimit=2 with 5 models keeps no more than 2 in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchFake = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const modelId: string = body.model;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        await new Promise((r) => setTimeout(r, 30));
        return jsonResponse(
          chatBody(normalPayload(1, 1, `${modelId} reasoning`), 0.001, modelId),
        );
      } finally {
        inFlight -= 1;
      }
    });

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["m1", "m2", "m3", "m4", "m5"],
      apiKey: "sk-test",
      concurrencyLimit: 2,
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.successCount).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  test("proposals preserve input order even when one model is slow", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "fast/a": { payload: normalPayload(1, 1), delayMs: 0 },
        "slow/b": { payload: normalPayload(2, 1), delayMs: 80 },
        "fast/c": { payload: normalPayload(3, 1), delayMs: 0 },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["fast/a", "slow/b", "fast/c"],
      apiKey: "sk-test",
      concurrencyLimit: 3,
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.proposals.map((p) => p.model)).toEqual([
      "fast/a",
      "slow/b",
      "fast/c",
    ]);
    expect(result.proposals[1].bundle?.proposedParams.mean).toBe(2);
  });
});

describe("researchConsensus — cost accounting", () => {
  test("totalCostUsd accumulates across all successful proposers", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(1, 1), cost: 0.0021 },
        "vendor/b": { payload: normalPayload(2, 1), cost: 0.0034 },
        "vendor/c": { payload: normalPayload(3, 1), cost: 0.0008 },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.totalCostUsd).toBeCloseTo(0.0021 + 0.0034 + 0.0008, 6);
  });
});

describe("researchConsensus — distribution envelopes", () => {
  test("triangular envelope: min(mins), max(maxes), mean(modes) clamped", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: triangularPayload(10, 30, 50) },
        "vendor/b": { payload: triangularPayload(20, 40, 60) },
        "vendor/c": { payload: triangularPayload(5, 25, 45) },
      }),
    );

    const result = await researchConsensus({
      component: { ...COMPONENT, suggestedDistribution: "triangular" },
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.consensus!.proposedDistribution).toBe("triangular");
    expect(result.consensus!.proposedParams.min).toBe(5);
    expect(result.consensus!.proposedParams.max).toBe(60);
    // mean of modes = (30+40+25)/3 ≈ 31.666, within [5, 60] → no clamp.
    expect(result.consensus!.proposedParams.mode).toBeCloseTo(
      (30 + 40 + 25) / 3,
      6,
    );
  });

  test("triangular envelope: mode clamped into widened interval when needed", async () => {
    // Construct a contrived case where mean(modes) would fall above the
    // widened max — should clamp to widened max.
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: triangularPayload(0, 100, 100) },
        "vendor/b": { payload: triangularPayload(0, 100, 100) },
        "vendor/c": {
          // Force a max smaller than the mean of modes via a separate
          // family wouldn't help since only same-family bundles inform
          // the envelope. Instead, give a triangular with very small max
          // so MAX(maxes) is still 100 — no clamp triggers here. Use a
          // direct numerical check instead: the clamp only activates if
          // mean(modes) > max(maxes), which is impossible when each
          // mode <= its own max. So this is a SANITY check that no
          // spurious clamp occurs in the normal case.
          payload: triangularPayload(50, 99, 100),
        },
      }),
    );

    const result = await researchConsensus({
      component: { ...COMPONENT, suggestedDistribution: "triangular" },
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.consensus!.proposedParams.min).toBe(0);
    expect(result.consensus!.proposedParams.max).toBe(100);
    const expectedMode = (100 + 100 + 99) / 3;
    expect(result.consensus!.proposedParams.mode).toBeCloseTo(expectedMode, 6);
    expect(result.consensus!.proposedParams.mode! <= 100).toBe(true);
    expect(result.consensus!.proposedParams.mode! >= 0).toBe(true);
  });

  test("beta envelope: min(alphas), min(betas) — conservative (less informative)", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: betaPayload(3, 7) },
        "vendor/b": { payload: betaPayload(5, 9) },
        "vendor/c": { payload: betaPayload(4, 6) },
      }),
    );

    const result = await researchConsensus({
      component: { ...COMPONENT, suggestedDistribution: "beta" },
      query: "q",
      models: ["vendor/a", "vendor/b", "vendor/c"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.consensus!.proposedDistribution).toBe("beta");
    // MIN(alphas) = 3, MIN(betas) = 6.
    expect(result.consensus!.proposedParams.alpha).toBe(3);
    expect(result.consensus!.proposedParams.beta).toBe(6);
  });

  test("uniform envelope: min(mins), max(maxes)", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": {
          payload: {
            proposedDistribution: "uniform",
            proposedParams: { min: 10, max: 20 },
            reasoning: "x",
          },
        },
        "vendor/b": {
          payload: {
            proposedDistribution: "uniform",
            proposedParams: { min: 5, max: 18 },
            reasoning: "y",
          },
        },
      }),
    );

    const result = await researchConsensus({
      component: { ...COMPONENT, suggestedDistribution: "uniform" },
      query: "q",
      models: ["vendor/a", "vendor/b"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.consensus!.proposedDistribution).toBe("uniform");
    expect(result.consensus!.proposedParams.min).toBe(5);
    expect(result.consensus!.proposedParams.max).toBe(20);
  });
});

describe("researchConsensus — per-model reasoning provenance", () => {
  test("each per-model bundle's reasoning is tagged with the model id", async () => {
    const fetchFake = jest.fn(
      buildLabelledFetch({
        "vendor/a": { payload: normalPayload(1, 1, "thinks A") },
        "vendor/b": { payload: normalPayload(2, 1, "thinks B") },
      }),
    );

    const result = await researchConsensus({
      component: COMPONENT,
      query: "q",
      models: ["vendor/a", "vendor/b"],
      apiKey: "sk-test",
      fetchImpl: fetchFake as unknown as typeof fetch,
    });

    expect(result.proposals[0].bundle!.reasoning).toMatch(/\[vendor\/a\]/);
    expect(result.proposals[0].bundle!.reasoning).toMatch(/thinks A/);
    expect(result.proposals[1].bundle!.reasoning).toMatch(/\[vendor\/b\]/);
  });
});

// Surface the named export so a lint-stricter project linter doesn't
// trip on an unused import — also a sanity-check that the error class
// is the named export the contract advertises.
test("ConsensusResearchError is exported with the right name", () => {
  const e = new ConsensusResearchError("x", "EMPTY_MODELS");
  expect(e.name).toBe("ConsensusResearchError");
  expect(e.code).toBe("EMPTY_MODELS");
});
