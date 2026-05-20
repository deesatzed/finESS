/**
 * Semantic Mode B5b — Empirical-as-research unit tests.
 *
 * The CSV rows below are tiny REAL fixtures (numbers, booleans, missing
 * cells) — NOT product mocks. They flow through the actual
 * `analyzeObservedRows` implementation; no analyzer code path is faked.
 */

import {
  EmpiricalResearchError,
  researchEmpirical,
  type EmpiricalResearchOptions,
} from "@/lib/semantic/research/empirical";
import type { ProposedComponent } from "@/lib/semantic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(
  overrides: Partial<ProposedComponent> = {},
): ProposedComponent {
  return {
    id: "observed_lab_value",
    name: "Observed Lab Value",
    description: "Empirically observed lab value from operator's CSV.",
    suggestedDistribution: "normal",
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<EmpiricalResearchOptions> = {},
): EmpiricalResearchOptions {
  return {
    component: makeComponent(),
    csvRows: [
      { value: 10 },
      { value: 11 },
      { value: 12 },
      { value: 13 },
      { value: 14 },
    ],
    targetColumn: "value",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("researchEmpirical — happy path", () => {
  test("returns an empirical_observation Normal bundle with mean/sd from the analyzer", async () => {
    const result = await researchEmpirical(baseOptions());

    expect(result.bundle.mechanism).toBe("empirical_observation");
    expect(result.bundle.proposedDistribution).toBe("normal");
    // mean of {10,11,12,13,14} = 12
    expect(result.bundle.proposedParams.mean).toBeCloseTo(12, 6);
    // sample sd = sqrt(sum((x-mean)^2)/(n-1)) = sqrt(10/4) = sqrt(2.5)
    expect(result.bundle.proposedParams.sd).toBeCloseTo(Math.sqrt(2.5), 6);
    expect(result.rowCount).toBe(5);
    expect(result.missingCount).toBe(0);
  });

  test("bundle.componentId is forced to component.id (not the targetColumn)", async () => {
    const result = await researchEmpirical(
      baseOptions({
        component: makeComponent({ id: "operator_named_factor" }),
        targetColumn: "value",
      }),
    );
    expect(result.bundle.componentId).toBe("operator_named_factor");
    expect(result.bundle.componentId).not.toBe("value");
  });

  test("citation source uses csv:<targetColumn> and snippet names mean/sd/rows", async () => {
    const result = await researchEmpirical(baseOptions());
    expect(result.bundle.citations).toHaveLength(1);
    const c = result.bundle.citations[0];
    expect(c.source).toBe("csv:value");
    expect(c.snippet).toMatch(/rows=5/);
    expect(c.snippet).toMatch(/missing=0/);
    expect(c.snippet).toMatch(/mean=12\.000/);
  });

  test("reasoning string includes row count, missing count, and 95% interval", async () => {
    const result = await researchEmpirical(baseOptions());
    expect(result.bundle.reasoning).toMatch(/Empirical observation over 5 rows/);
    expect(result.bundle.reasoning).toMatch(/0 missing for target "value"/);
    expect(result.bundle.reasoning).toMatch(/Distribution = Normal\(12\.000, /);
    expect(result.bundle.reasoning).toMatch(/95% empirical interval \[/);
  });

  test("counts missing cells correctly", async () => {
    const result = await researchEmpirical(
      baseOptions({
        csvRows: [
          { value: 10 },
          { value: 11 },
          { value: "" },
          { value: 12 },
          { value: 13 },
        ],
      }),
    );
    expect(result.rowCount).toBe(4);
    expect(result.missingCount).toBe(1);
  });

  test("handles binary 0/1 columns without collapsing to degenerate", async () => {
    const result = await researchEmpirical(
      baseOptions({
        csvRows: [{ flag: 0 }, { flag: 1 }, { flag: 1 }, { flag: 0 }, { flag: 1 }],
        targetColumn: "flag",
      }),
    );
    expect(result.bundle.proposedParams.mean).toBeCloseTo(0.6, 6);
    expect(result.bundle.proposedParams.sd).toBeGreaterThan(0);
  });
});

describe("researchEmpirical — input validation", () => {
  test("empty csvRows -> EMPTY_CSV", async () => {
    await expect(
      researchEmpirical(baseOptions({ csvRows: [] })),
    ).rejects.toMatchObject({
      name: "EmpiricalResearchError",
      code: "EMPTY_CSV",
    });
  });

  test("missing component id -> EMPTY_CSV", async () => {
    await expect(
      researchEmpirical(
        baseOptions({ component: makeComponent({ id: "   " }) }),
      ),
    ).rejects.toMatchObject({
      name: "EmpiricalResearchError",
      code: "EMPTY_CSV",
    });
  });

  test("empty targetColumn -> EMPTY_CSV", async () => {
    await expect(
      researchEmpirical(baseOptions({ targetColumn: "" })),
    ).rejects.toMatchObject({
      name: "EmpiricalResearchError",
      code: "EMPTY_CSV",
    });
  });
});

describe("researchEmpirical — analyzer-driven error mapping", () => {
  test("all rows missing target -> ALL_MISSING (pre-analyzer fast path)", async () => {
    await expect(
      researchEmpirical(
        baseOptions({
          csvRows: [{ value: "" }, { value: "" }, { value: "" }],
        }),
      ),
    ).rejects.toMatchObject({
      name: "EmpiricalResearchError",
      code: "ALL_MISSING",
    });
  });

  test("target column not numeric/binary -> wraps analyzer error as EMPTY_CSV", async () => {
    // The analyzer raises "Row N target value is not numeric or binary"
    // for an unparseable cell; we surface that as EMPTY_CSV (input shape).
    await expect(
      researchEmpirical(
        baseOptions({
          csvRows: [{ value: "abc" }, { value: "def" }],
        }),
      ),
    ).rejects.toMatchObject({
      name: "EmpiricalResearchError",
      code: "EMPTY_CSV",
    });
  });

  test("constant column (sd === 0) -> DEGENERATE_DISTRIBUTION", async () => {
    await expect(
      researchEmpirical(
        baseOptions({
          csvRows: [
            { value: 7 },
            { value: 7 },
            { value: 7 },
            { value: 7 },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      name: "EmpiricalResearchError",
      code: "DEGENERATE_DISTRIBUTION",
    });
  });
});

describe("EmpiricalResearchError", () => {
  test("carries the code field for callers to switch on", () => {
    const err = new EmpiricalResearchError("boom", "DEGENERATE_DISTRIBUTION");
    expect(err.name).toBe("EmpiricalResearchError");
    expect(err.code).toBe("DEGENERATE_DISTRIBUTION");
    expect(err instanceof Error).toBe(true);
  });
});
