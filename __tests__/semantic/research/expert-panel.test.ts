/**
 * Phase B7 — Expert Panel research mechanism unit tests.
 *
 * No external dependencies (no LLM, no HTTP, no DB). The mechanism is
 * a pure statistical transform, so every test is a deterministic
 * input/output pair.
 */

import {
  ExpertPanelError,
  researchExpertPanel,
  type ExpertPanelOptions,
} from "@/lib/semantic/research/expert-panel";
import type { ProposedComponent } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<ProposedComponent> = {},
): ProposedComponent {
  return {
    id: "c1",
    name: "Test Component",
    description: "A component for tests",
    ...overrides,
  };
}

function makeOpts(
  overrides: Partial<ExpertPanelOptions> = {},
): ExpertPanelOptions {
  return {
    component: makeComponent(),
    estimates: [10, 20, 30],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy paths — one per distribution
// ---------------------------------------------------------------------------

describe("researchExpertPanel happy paths", () => {
  it("normal: estimates [10, 20, 30] → mean=20, sample-sd=10, distribution=normal", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [10, 20, 30], distribution: "normal" }),
    );
    expect(result.bundle.proposedDistribution).toBe("normal");
    expect(result.bundle.proposedParams.mean).toBeCloseTo(20, 10);
    // Sample sd of [10,20,30]: sqrt(((10-20)^2 + (20-20)^2 + (30-20)^2)/2) = 10
    expect(result.bundle.proposedParams.sd).toBeCloseTo(10, 10);
    expect(result.rawStatistics.n).toBe(3);
    expect(result.rawStatistics.median).toBe(20);
    expect(result.bundle.mechanism).toBe("expert_panel");
  });

  it("beta: estimates [0.1, 0.2, 0.3] → distribution=beta with alpha, beta both > 0", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [0.1, 0.2, 0.3], distribution: "beta" }),
    );
    expect(result.bundle.proposedDistribution).toBe("beta");
    expect(result.bundle.proposedParams.alpha).toBeDefined();
    expect(result.bundle.proposedParams.beta).toBeDefined();
    expect(result.bundle.proposedParams.alpha!).toBeGreaterThan(0);
    expect(result.bundle.proposedParams.beta!).toBeGreaterThan(0);
    expect(result.bundle.proposedParams.mean).toBeCloseTo(0.2, 10);
  });

  it("lognormal: estimates [1, 2, 4, 8] → distribution=lognormal with positive mean/sd", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [1, 2, 4, 8], distribution: "lognormal" }),
    );
    expect(result.bundle.proposedDistribution).toBe("lognormal");
    expect(result.bundle.proposedParams.mean!).toBeGreaterThan(0);
    expect(result.bundle.proposedParams.sd!).toBeGreaterThan(0);
    // Raw mean is (1+2+4+8)/4 = 3.75
    expect(result.bundle.proposedParams.mean).toBeCloseTo(3.75, 10);
  });

  it("triangular: estimates [10, 50, 90] → min=10, mode=50 (median), max=90", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [10, 50, 90], distribution: "triangular" }),
    );
    expect(result.bundle.proposedDistribution).toBe("triangular");
    expect(result.bundle.proposedParams.min).toBe(10);
    expect(result.bundle.proposedParams.mode).toBe(50);
    expect(result.bundle.proposedParams.max).toBe(90);
  });

  it("uniform: estimates [5, 15] → min=5, max=15", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [5, 15], distribution: "uniform" }),
    );
    expect(result.bundle.proposedDistribution).toBe("uniform");
    expect(result.bundle.proposedParams.min).toBe(5);
    expect(result.bundle.proposedParams.max).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

describe("researchExpertPanel validation", () => {
  it("throws TOO_FEW_ESTIMATES with 1 estimate", () => {
    expect(() => researchExpertPanel(makeOpts({ estimates: [42] }))).toThrow(
      ExpertPanelError,
    );
    try {
      researchExpertPanel(makeOpts({ estimates: [42] }));
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("TOO_FEW_ESTIMATES");
    }
  });

  it("throws TOO_FEW_ESTIMATES with 0 estimates", () => {
    try {
      researchExpertPanel(makeOpts({ estimates: [] }));
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("TOO_FEW_ESTIMATES");
    }
  });

  it("throws TOO_MANY_ESTIMATES with 51 estimates", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
    try {
      researchExpertPanel(makeOpts({ estimates: tooMany }));
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("TOO_MANY_ESTIMATES");
    }
  });

  it("accepts exactly 50 estimates (boundary)", () => {
    const exactlyFifty = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(() =>
      researchExpertPanel(makeOpts({ estimates: exactlyFifty })),
    ).not.toThrow();
  });

  it("throws NON_FINITE_ESTIMATE for NaN at index 1, naming that index", () => {
    try {
      researchExpertPanel(makeOpts({ estimates: [10, Number.NaN, 30] }));
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      const e = err as ExpertPanelError;
      expect(e.code).toBe("NON_FINITE_ESTIMATE");
      expect(e.message).toContain("index 1");
    }
  });

  it("throws NON_FINITE_ESTIMATE for Infinity", () => {
    try {
      researchExpertPanel(
        makeOpts({ estimates: [10, 20, Number.POSITIVE_INFINITY] }),
      );
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("NON_FINITE_ESTIMATE");
    }
  });

  it("throws DEGENERATE_PANEL when all estimates are identical", () => {
    try {
      researchExpertPanel(makeOpts({ estimates: [7, 7, 7, 7] }));
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("DEGENERATE_PANEL");
    }
  });
});

// ---------------------------------------------------------------------------
// Distribution-specific rejections
// ---------------------------------------------------------------------------

describe("researchExpertPanel distribution-fit checks", () => {
  it("beta rejects an estimate > 1 with UNSUPPORTED_DISTRIBUTION", () => {
    try {
      researchExpertPanel(
        makeOpts({ estimates: [0.1, 0.5, 1.2], distribution: "beta" }),
      );
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      const e = err as ExpertPanelError;
      expect(e.code).toBe("UNSUPPORTED_DISTRIBUTION");
      expect(e.message).toContain("index 2");
    }
  });

  it("beta rejects an estimate < 0 with UNSUPPORTED_DISTRIBUTION", () => {
    try {
      researchExpertPanel(
        makeOpts({ estimates: [-0.1, 0.2, 0.3], distribution: "beta" }),
      );
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      const e = err as ExpertPanelError;
      expect(e.code).toBe("UNSUPPORTED_DISTRIBUTION");
      expect(e.message).toContain("index 0");
    }
  });

  it("lognormal rejects a zero estimate with UNSUPPORTED_DISTRIBUTION", () => {
    try {
      researchExpertPanel(
        makeOpts({ estimates: [1, 0, 4], distribution: "lognormal" }),
      );
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      const e = err as ExpertPanelError;
      expect(e.code).toBe("UNSUPPORTED_DISTRIBUTION");
      expect(e.message).toContain("index 1");
    }
  });

  it("lognormal rejects a negative estimate with UNSUPPORTED_DISTRIBUTION", () => {
    try {
      researchExpertPanel(
        makeOpts({ estimates: [1, 2, -3], distribution: "lognormal" }),
      );
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("UNSUPPORTED_DISTRIBUTION");
    }
  });

  it("uniform rejects min === max", () => {
    // Forcing identical estimates would hit DEGENERATE_PANEL first, so
    // construct via hardBounds that collapse the range while estimates
    // themselves disagree.
    try {
      researchExpertPanel(
        makeOpts({
          estimates: [5, 15],
          distribution: "uniform",
          hardBounds: { min: 10, max: 10 },
        }),
      );
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertPanelError);
      expect((err as ExpertPanelError).code).toBe("UNSUPPORTED_DISTRIBUTION");
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle structure / contract checks
// ---------------------------------------------------------------------------

describe("researchExpertPanel bundle content", () => {
  it("honors `labels` when provided: citations[0].source matches labels[0]", () => {
    const labels = ["Dr. Alpha", "Dr. Beta", "Dr. Gamma"];
    const result = researchExpertPanel(
      makeOpts({ estimates: [10, 20, 30], labels }),
    );
    expect(result.bundle.citations).toHaveLength(3);
    expect(result.bundle.citations[0].source).toBe("Dr. Alpha");
    expect(result.bundle.citations[1].source).toBe("Dr. Beta");
    expect(result.bundle.citations[2].source).toBe("Dr. Gamma");
    expect(result.bundle.citations[0].snippet).toBe("10");
  });

  it("falls back to expert-N source when no labels provided", () => {
    const result = researchExpertPanel(makeOpts({ estimates: [10, 20] }));
    expect(result.bundle.citations[0].source).toBe("expert-1");
    expect(result.bundle.citations[1].source).toBe("expert-2");
  });

  it("honors hardBounds for uniform", () => {
    const result = researchExpertPanel(
      makeOpts({
        estimates: [5, 15],
        distribution: "uniform",
        hardBounds: { min: 0, max: 100 },
      }),
    );
    expect(result.bundle.proposedParams.min).toBe(0);
    expect(result.bundle.proposedParams.max).toBe(100);
  });

  it("honors hardBounds for triangular", () => {
    const result = researchExpertPanel(
      makeOpts({
        estimates: [10, 50, 90],
        distribution: "triangular",
        hardBounds: { min: 0, max: 100 },
      }),
    );
    expect(result.bundle.proposedParams.min).toBe(0);
    expect(result.bundle.proposedParams.max).toBe(100);
    expect(result.bundle.proposedParams.mode).toBe(50);
  });

  it("rawStatistics fields are correct for an even-length panel (median is midpoint of two centre values)", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [1, 2, 3, 4], distribution: "normal" }),
    );
    expect(result.rawStatistics.n).toBe(4);
    expect(result.rawStatistics.mean).toBeCloseTo(2.5, 10);
    expect(result.rawStatistics.min).toBe(1);
    expect(result.rawStatistics.max).toBe(4);
    expect(result.rawStatistics.median).toBeCloseTo(2.5, 10);
    // Sample sd of [1,2,3,4]: sqrt((2.25+0.25+0.25+2.25)/3) = sqrt(5/3)
    expect(result.rawStatistics.sd).toBeCloseTo(Math.sqrt(5 / 3), 10);
  });

  it("componentId on bundle equals component.id even for unusual ids", () => {
    const component = makeComponent({
      id: "weird/id with spaces & symbols!@#",
    });
    const result = researchExpertPanel({
      component,
      estimates: [10, 20, 30],
      distribution: "normal",
    });
    expect(result.bundle.componentId).toBe(
      "weird/id with spaces & symbols!@#",
    );
  });

  it("distribution precedence: opts.distribution wins over component.suggestedDistribution", () => {
    const component = makeComponent({ suggestedDistribution: "beta" });
    const result = researchExpertPanel({
      component,
      estimates: [10, 20, 30],
      distribution: "normal",
    });
    expect(result.bundle.proposedDistribution).toBe("normal");
  });

  it("distribution precedence: component.suggestedDistribution wins when opts.distribution is undefined", () => {
    const component = makeComponent({ suggestedDistribution: "uniform" });
    const result = researchExpertPanel({
      component,
      estimates: [10, 20, 30],
    });
    expect(result.bundle.proposedDistribution).toBe("uniform");
  });

  it("distribution precedence: defaults to 'normal' when neither is set", () => {
    const result = researchExpertPanel({
      component: makeComponent(),
      estimates: [10, 20, 30],
    });
    expect(result.bundle.proposedDistribution).toBe("normal");
  });

  it("reasoning string includes every estimate, the mean, sd, range, and Principle 2 citation", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [10, 20, 30], distribution: "normal" }),
    );
    expect(result.bundle.reasoning).toContain("10");
    expect(result.bundle.reasoning).toContain("20");
    expect(result.bundle.reasoning).toContain("30");
    expect(result.bundle.reasoning).toContain("Mean");
    expect(result.bundle.reasoning).toContain("SD");
    expect(result.bundle.reasoning).toContain("Principle 2");
  });

  it("mechanism field is always 'expert_panel'", () => {
    const result = researchExpertPanel(
      makeOpts({ estimates: [10, 20, 30], distribution: "normal" }),
    );
    expect(result.bundle.mechanism).toBe("expert_panel");
  });
});
