"use client";

/**
 * ResearchStep — renders both RESEARCHING and REVIEWING_RESEARCH
 * states. Per component, shows status (queued / in-flight / received
 * / accepted), the active mechanism, and the bundle reasoning once
 * one arrives. Phase B fills in the actual mechanism implementations
 * &mdash; here the "Start research" buttons are placeholders that
 * dispatch the `startResearch` event with the selected mechanism so
 * the panel/server can hand off to the appropriate adapter later.
 *
 * Until Phase B lands, the buttons are disabled with an explicit
 * "Research mechanisms ship in Phase B" affordance &mdash; we do NOT
 * fake a bundle. The honest-uncertainty contract forbids that.
 */
import type {
  ProposedComponent,
  ResearchBundle,
  ResearchMechanism,
} from "@/lib/semantic/types";

interface ResearchStepProps {
  components: ProposedComponent[];
  threshold: number;
  thresholdLabel: string;
  bundles: Record<string, ResearchBundle>;
  inFlight: Record<string, ResearchMechanism>;
  accepted: Record<string, true>;
  /** "researching" or "reviewing" — drives which footer CTAs render. */
  phase: "researching" | "reviewing";
  isBusy: boolean;
  onStartResearch: (componentId: string, mechanism: ResearchMechanism) => void;
  onAcceptResearch: (componentId: string) => void;
  onRunModel: () => void;
  onBack?: () => void;
  onReset: () => void;
}

const MECHANISM_LABEL: Record<ResearchMechanism, string> = {
  llm_prior: "LLM general knowledge",
  web_search: "Web search with citations",
  rag_document: "Your uploaded documents",
  multi_llm_consensus: "Multi-LLM consensus",
  ensemble_forecast: "Forecast Mode ensemble",
  empirical_observation: "Real Data Mode (CSV)",
  expert_panel: "Expert estimates you enter",
};

export function ResearchStep({
  components,
  threshold,
  thresholdLabel,
  bundles,
  inFlight,
  accepted,
  phase,
  isBusy,
  onStartResearch,
  onAcceptResearch,
  onRunModel,
  onBack,
  onReset,
}: ResearchStepProps) {
  const totalAccepted = Object.keys(accepted).length;
  const canRunModel =
    phase === "reviewing" && totalAccepted === components.length;

  return (
    <section
      aria-labelledby="research-heading"
      className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 space-y-3"
    >
      <header className="flex items-center justify-between">
        <h2
          id="research-heading"
          className="text-sm font-semibold text-[#e2e8f0]"
        >
          Step 4 &mdash; Research each component
        </h2>
        <span className="text-[11px] text-[#64748b]">
          Threshold: {thresholdLabel} ({threshold})
        </span>
      </header>
      <p className="text-xs text-[#94a3b8]">
        Each component gets researched. Pick a mechanism per component
        &mdash; disagreement across mechanisms is useful honesty, not
        contradiction.
      </p>
      <ul className="space-y-2">
        {components.map((c) => {
          const bundle = bundles[c.id];
          const mech = inFlight[c.id];
          const isAccepted = accepted[c.id] === true;
          const status: string = isAccepted
            ? "accepted"
            : bundle
              ? "research received"
              : mech
                ? "researching..."
                : "not yet researched";
          return (
            <li
              key={c.id}
              className="rounded border border-[#1e293b] bg-[#0a0e1a] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-[#e2e8f0]">
                    {c.name}
                  </p>
                  <p className="mt-1 text-[11px] text-[#94a3b8]">
                    {c.description}
                  </p>
                  <p className="mt-2 text-[11px] text-[#cbd5e1]">
                    Status: <span className="font-medium">{status}</span>
                  </p>
                  {mech && !bundle && (
                    <p className="mt-1 text-[11px] italic text-[#64748b]">
                      Mechanism: {MECHANISM_LABEL[mech]}
                    </p>
                  )}
                  {bundle && (
                    <div className="mt-2 rounded bg-[#1e293b] p-2 text-[11px] text-[#cbd5e1]">
                      <p className="text-[10px] uppercase tracking-wider text-[#64748b]">
                        {MECHANISM_LABEL[bundle.mechanism]}
                      </p>
                      <p className="mt-1">{bundle.reasoning}</p>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {phase === "researching" && !bundle && (
                    <select
                      aria-label={`Pick research mechanism for ${c.name}`}
                      disabled={isBusy || Boolean(mech)}
                      defaultValue=""
                      onChange={(e) => {
                        const value = e.target.value as ResearchMechanism | "";
                        if (value) onStartResearch(c.id, value);
                      }}
                      className="rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1 text-[11px] text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none disabled:opacity-50"
                    >
                      <option value="">Pick mechanism...</option>
                      {(
                        Object.keys(MECHANISM_LABEL) as ResearchMechanism[]
                      ).map((m) => (
                        <option key={m} value={m}>
                          {MECHANISM_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  )}
                  {phase === "reviewing" && bundle && !isAccepted && (
                    <button
                      type="button"
                      onClick={() => onAcceptResearch(c.id)}
                      disabled={isBusy}
                      className="rounded bg-[#10b981] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#059669] disabled:opacity-50"
                    >
                      Accept
                    </button>
                  )}
                  {isAccepted && (
                    <span className="rounded bg-[#1e293b] px-2 py-1 text-[11px] text-[#10b981]">
                      Accepted
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[10px] italic text-[#64748b]">
        Research mechanism implementations ship in Phase B. Once they
        land, picking a mechanism above will kick off the actual
        research and populate the bundle inline.
      </p>
      <footer className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              disabled={isBusy}
              className="rounded border border-[#1e293b] px-3 py-1.5 text-xs text-[#94a3b8] hover:text-white disabled:opacity-50"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            disabled={isBusy}
            className="text-[11px] text-[#64748b] underline-offset-2 hover:text-[#94a3b8] hover:underline disabled:opacity-50"
          >
            Start over
          </button>
        </div>
        {phase === "reviewing" && (
          <button
            type="button"
            onClick={onRunModel}
            disabled={isBusy || !canRunModel}
            className="rounded bg-[#3b82f6] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Run model ({totalAccepted}/{components.length} accepted)
          </button>
        )}
      </footer>
    </section>
  );
}

export default ResearchStep;
