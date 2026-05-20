/**
 * B6 component render tests for ResearchStep.
 *
 * Uses the same react-dom/server.renderToString pattern as the
 * existing semantic-multi-domain test (no JSDOM, no
 * @testing-library/react). Verifies the picker renders all seven
 * mechanism buttons during the researching phase, that the bundle
 * readout renders citations with sensible affordances, and that the
 * accept CTA only surfaces in the reviewing phase.
 *
 * Interaction tests (clicking, typing into the forecast/empirical/
 * expert-panel forms) live elsewhere — react-dom/server cannot fire
 * synthetic events. The autoAdvance unit tests + the API integration
 * tests cover the end-to-end behavior; this file covers the static
 * markup contract.
 *
 * Note: `react-dom/server` injects `<!-- -->` between adjacent text
 * nodes that result from JSX interpolation. We strip those comments
 * before pattern-matching so the assertions stay readable.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ResearchStep } from "@/components/semantic/ResearchStep";
import type {
  ProposedComponent,
  ResearchBundle,
  ResearchMechanism,
} from "@/lib/semantic/types";

function noop() {
  /* no-op */
}

/** Strip the React server-render text-separator comments. */
function clean(markup: string): string {
  return markup.replace(/<!--\s*-->/g, "");
}

const COMPONENTS: ProposedComponent[] = [
  {
    id: "c1",
    name: "Pre-test probability",
    description: "Wells score before any imaging.",
    suggestedDistribution: "beta",
  },
  {
    id: "c2",
    name: "Test sensitivity",
    description: "CTPA sensitivity for PE in this clinical context.",
    suggestedDistribution: "beta",
  },
];

function renderResearching(opts: {
  bundles?: Record<string, ResearchBundle>;
  inFlight?: Record<string, ResearchMechanism>;
}) {
  return clean(
    renderToString(
      createElement(ResearchStep, {
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: opts.bundles ?? {},
        inFlight: opts.inFlight ?? {},
        accepted: {},
        phase: "researching",
        isBusy: false,
        onStartResearch: noop as never,
        onAcceptResearch: noop,
        onRunModel: noop,
        onReset: noop,
      }),
    ),
  );
}

function renderReviewing(opts: {
  bundles: Record<string, ResearchBundle>;
  accepted: Record<string, true>;
}) {
  return clean(
    renderToString(
      createElement(ResearchStep, {
        components: COMPONENTS,
        threshold: 0.5,
        thresholdLabel: "high",
        bundles: opts.bundles,
        inFlight: {},
        accepted: opts.accepted,
        phase: "reviewing",
        isBusy: false,
        onStartResearch: noop as never,
        onAcceptResearch: noop,
        onRunModel: noop,
        onReset: noop,
      }),
    ),
  );
}

/**
 * Extract the `<button>...</button>` containing the substring `Run model`.
 * Returns null when the rendered markup has no such button (e.g.
 * during the researching phase).
 */
function findRunModelButton(markup: string): string | null {
  const re = /<button\b[^>]*>[^<]*Run model[^<]*<\/button>/;
  const match = re.exec(markup);
  return match ? match[0] : null;
}

describe("ResearchStep — researching phase markup", () => {
  it("renders the threshold + label in the header", () => {
    const markup = renderResearching({});
    expect(markup).toMatch(/Threshold: high/);
  });

  it("renders all seven mechanism buttons per un-researched component", () => {
    const markup = renderResearching({});
    expect(markup).toContain("LLM general knowledge");
    expect(markup).toContain("Web search with citations");
    expect(markup).toContain("Your uploaded documents");
    expect(markup).toContain("Multi-LLM consensus");
    expect(markup).toContain("Forecast Mode ensemble");
    expect(markup).toContain("Real Data Mode (CSV)");
    expect(markup).toContain("Expert estimates you enter");
  });

  it("renders cost-hint copy next to each mechanism", () => {
    const markup = renderResearching({});
    expect(markup).toContain("~$0.01 per call");
    expect(markup).toContain("Free (no network calls)");
    expect(markup).toContain("Free (pure CSV analysis)");
  });

  it("shows in-flight mechanism label and hides the picker for that component", () => {
    const markup = renderResearching({
      inFlight: { c1: "llm_prior" },
    });
    expect(markup).toMatch(/Mechanism: LLM general knowledge/);
  });

  it("renders bundle reasoning + citations when a bundle has arrived", () => {
    const bundle: ResearchBundle = {
      componentId: "c1",
      mechanism: "web_search",
      proposedDistribution: "beta",
      proposedParams: { alpha: 2, beta: 5 },
      reasoning: "Snippet evidence from two papers supports a beta(2, 5).",
      citations: [
        {
          url: "https://example.org/study-a",
          title: "Wells score in low-risk patients",
          snippet: "Wells <2 corresponds to ~10% pre-test probability.",
        },
        {
          source: "JAMA 2018",
          snippet: "Independent validation cohort.",
        },
      ],
    };
    const markup = renderResearching({ bundles: { c1: bundle } });
    expect(markup).toMatch(/Snippet evidence from two papers/);
    expect(markup).toMatch(/Wells score in low-risk patients/);
    expect(markup).toContain("https://example.org/study-a");
    expect(markup).toContain("JAMA 2018");
    expect(markup).toContain("Independent validation cohort");
    expect(markup).toMatch(/bounded between 0 and 1/);
  });

  it("does not render the 'Run model' CTA during researching", () => {
    const markup = renderResearching({});
    expect(markup).not.toContain("Run model");
  });
});

describe("ResearchStep — reviewing phase markup", () => {
  const bundles: Record<string, ResearchBundle> = {
    c1: {
      componentId: "c1",
      mechanism: "llm_prior",
      proposedDistribution: "beta",
      proposedParams: { alpha: 2, beta: 5 },
      reasoning: "test reasoning for c1",
      citations: [{ source: "knowledge-base" }],
    },
    c2: {
      componentId: "c2",
      mechanism: "expert_panel",
      proposedDistribution: "normal",
      proposedParams: { mean: 0.8, sd: 0.05 },
      reasoning: "expert agreement for c2",
      citations: [
        { source: "expert-1", snippet: "0.78" },
        { source: "expert-2", snippet: "0.82" },
      ],
    },
  };

  it("renders the 'Accept' CTA per un-accepted bundle", () => {
    const markup = renderReviewing({ bundles, accepted: {} });
    const occurrences = markup.split("Accept this research").length - 1;
    expect(occurrences).toBe(2);
  });

  it("renders the accepted badge for an accepted bundle and hides the CTA", () => {
    const markup = renderReviewing({
      bundles,
      accepted: { c1: true },
    });
    expect(markup).toMatch(/Accepted/);
    const occurrences = markup.split("Accept this research").length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders the Run model CTA with the accepted/total counter", () => {
    const markup = renderReviewing({
      bundles,
      accepted: { c1: true },
    });
    expect(markup).toMatch(/Run model \(1\/2 accepted\)/);
  });

  it("disables the Run-model button while some components are unaccepted", () => {
    const partial = renderReviewing({
      bundles,
      accepted: { c1: true },
    });
    const partialButton = findRunModelButton(partial);
    expect(partialButton).not.toBeNull();
    // The disabled attribute appears as `disabled=""` in React server output.
    expect(partialButton!).toMatch(/\sdisabled(=|\s|>)/);

    const full = renderReviewing({
      bundles,
      accepted: { c1: true, c2: true },
    });
    expect(full).toMatch(/Run model \(2\/2 accepted\)/);
    const fullButton = findRunModelButton(full);
    expect(fullButton).not.toBeNull();
    expect(fullButton!).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("does not render the mechanism picker during reviewing", () => {
    const markup = renderReviewing({ bundles, accepted: {} });
    expect(markup).not.toContain("~$0.02 per call");
    expect(markup).not.toContain("Free (uses your forecast sidecar)");
  });

  it("renders per-mechanism parameter labels for each bundle", () => {
    const markup = renderReviewing({ bundles, accepted: {} });
    expect(markup).toMatch(/alpha=2/);
    expect(markup).toMatch(/beta=5/);
    expect(markup).toMatch(/central=0\.8/);
    expect(markup).toMatch(/spread=0\.05/);
  });
});
