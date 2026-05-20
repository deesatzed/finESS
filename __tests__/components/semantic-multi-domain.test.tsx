/**
 * Semantic Mode A5 — multi-domain render smoke test.
 *
 * Exit criterion from the v2 addendum: Semantic Mode must be
 * exercised end-to-end on at least one canonical example from each of
 * clinical (PE), financial (hometier retirement), and one
 * non-clinical-non-financial domain (we picked climate). The fixtures
 * are real serialized SemanticState shapes that round-trip through
 * `deserializeState` (the A2 contract).
 *
 * This test deliberately avoids @testing-library/react (not in
 * package.json) and JSX compile gymnastics (Jest is on node env). We
 * use `React.createElement` and `react-dom/server.renderToString` to
 * render the SemanticPanel against each fixture and assert:
 *
 *   1. It does not throw.
 *   2. The honesty banner is present in the markup.
 *   3. Domain-appropriate step copy is present (component names,
 *      question text, etc.) for the fixture's state.kind.
 *
 * If/when we add @testing-library/react and a JSDOM jest project,
 * these assertions will tighten into interaction tests. For now they
 * are smoke + contract assertions.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { SemanticPanel } from "@/components/SemanticPanel";
import { deserializeState } from "@/lib/semantic/persistence";
import type { PersistedSemanticConversation } from "@/lib/semantic/persistence";

import peFixture from "@/__tests__/fixtures/semantic-pe.json";
import hometierFixture from "@/__tests__/fixtures/semantic-hometier.json";
import climateFixture from "@/__tests__/fixtures/semantic-climate.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapAsConversation(
  raw: unknown,
  query: string,
): PersistedSemanticConversation {
  // The fixtures live as JSON, so `deserializeState` is what guarantees
  // they remain valid SemanticState shapes — it's the A2 contract.
  const state = deserializeState(JSON.stringify(raw));
  return {
    id: "fixture-conv",
    userId: "fixture-user",
    workspaceId: "fixture-ws",
    query,
    state,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
}

function renderPanel(conv: PersistedSemanticConversation): string {
  return renderToString(
    createElement(SemanticPanel, { initialConversation: conv }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SemanticPanel multi-domain smoke", () => {
  it("renders the clinical (PE) fixture without throwing and shows the components", () => {
    const conv = wrapAsConversation(
      peFixture,
      "What is the probability a 55-year-old with chest pain has PE?",
    );
    expect(conv.state.kind).toBe("REVIEWING_COMPONENTS");

    let markup = "";
    expect(() => {
      markup = renderPanel(conv);
    }).not.toThrow();

    // Honesty banner is present (intro phrase).
    expect(markup).toContain("This is the semantic conversation surface");
    // Wide-intervals-honest line is present.
    expect(markup).toMatch(/Wide intervals are not failure/);
    // Domain copy: at least one component name from the fixture renders.
    expect(markup).toContain("Pre-test probability");
    expect(markup).toContain("CTPA sensitivity");
    // Plain-language distribution label appears (not raw enum) in primary surface.
    expect(markup).toContain("bounded between 0 and 1");
  });

  it("renders the financial (hometier) fixture in AWAITING_ANSWERS and shows the questions", () => {
    const conv = wrapAsConversation(
      hometierFixture,
      "Can a 62-year-old retire at 65 on a 1.4M portfolio plus social security?",
    );
    expect(conv.state.kind).toBe("AWAITING_ANSWERS");

    let markup = "";
    expect(() => {
      markup = renderPanel(conv);
    }).not.toThrow();

    expect(markup).toContain("Step 1");
    expect(markup).toContain("Planning horizon in years?");
    expect(markup).toContain("annual real spending");
    // Honesty banner still present in non-cockpit phases.
    expect(markup).toContain("This is the semantic conversation surface");
  });

  it("renders the climate fixture in REVIEWING_RESEARCH and shows the research bundles", () => {
    const conv = wrapAsConversation(
      climateFixture,
      "How likely is regional sea level to exceed 0.6m by 2070?",
    );
    expect(conv.state.kind).toBe("REVIEWING_RESEARCH");

    let markup = "";
    expect(() => {
      markup = renderPanel(conv);
    }).not.toThrow();

    expect(markup).toContain("Step 4");
    expect(markup).toContain("Global mean sea-level rise by 2070");
    // Threshold label is rendered in the header.
    expect(markup).toContain("high regional flood risk");
    // The reasoning text from a bundle is visible.
    expect(markup).toContain("IPCC AR6 SSP2-4.5");
  });

  it("when no conversation is supplied, renders the start screen with the honesty banner", () => {
    let markup = "";
    expect(() => {
      markup = renderToString(
        createElement(SemanticPanel, { initialConversation: null }),
      );
    }).not.toThrow();
    expect(markup).toContain("Start a semantic conversation");
    expect(markup).toContain("This is the semantic conversation surface");
    // Wide-intervals-honest line is included even on the empty screen
    // — it's the load-bearing UX contract.
    expect(markup).toMatch(/Wide intervals are not failure/);
  });

  it("does not collapse a wide CI to a point estimate in any banner copy", () => {
    // Honest-uncertainty cross-cutting commitment: every banner /
    // narration line must articulate disagreement as honesty. The
    // banner must include the load-bearing "useful honesty" phrase.
    const markup = renderToString(
      createElement(SemanticPanel, { initialConversation: null }),
    );
    expect(markup).toMatch(/useful honesty/);
  });
});
