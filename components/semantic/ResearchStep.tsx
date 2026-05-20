"use client";

/**
 * ResearchStep — renders both RESEARCHING and REVIEWING_RESEARCH
 * states. Per component, shows status (queued / in-flight / received /
 * accepted), the active mechanism, and the bundle reasoning + citations
 * once one arrives.
 *
 * B6 pinned decisions (rationale captured here so future maintainers
 * understand why these knobs exist):
 *
 *  1. CSV source for forecast + empirical mechanisms: the user pastes
 *     CSV INLINE in this step (option (a) in the B6 plan). Picking from
 *     an existing Real-Data analysis is a future refinement — it would
 *     require a list/picker UI and a server-side cross-reference to the
 *     `Analysis` table; out of scope for B6.
 *
 *  2. RAG document scoping: the rag_document mechanism always queries
 *     ALL workspace-uploaded documents. Per-document scoping would add
 *     a multi-select picker; deferred per the B6 plan.
 *
 *  3. Expert-panel UI: a dynamic list of plain numeric inputs (add /
 *     remove rows). Each row optionally carries a label. UI-side
 *     validation is minimal ("must be a number") — the server-side
 *     researchExpertPanel adapter is the source of truth for everything
 *     else (TOO_FEW_ESTIMATES, DEGENERATE_PANEL, distribution-fit
 *     constraints).
 *
 *  4. Multi-mechanism toggle (concurrent research across mechanisms
 *     with disagreement surfaced): SKIPPED for B6. Each component gets
 *     ONE accepted bundle. Pinned as a Phase D item.
 *
 * On the wire: clicking a "Run" button dispatches `startResearch` with
 * the chosen mechanism and (where applicable) mechanism-specific
 * inputs. The server fires the corresponding adapter immediately and
 * applies the result-event before responding — see
 * `lib/semantic/auto-advance.ts`.
 */
import { useMemo, useState } from "react";
import type {
  ProposedComponent,
  ResearchBundle,
  ResearchCitation,
  ResearchMechanism,
  SemanticDistribution,
} from "@/lib/semantic/types";
import type { StartResearchInputs } from "@/lib/semantic/state-machine";

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
  /**
   * B6: signature widened so the UI can carry mechanism-specific inputs
   * (CSV rows for forecast/empirical, estimates for expert_panel, etc.)
   * straight through to the server-side dispatcher. The inputs object
   * is optional — mechanisms that need no extra input (llm_prior,
   * web_search, rag_document, multi_llm_consensus) omit it.
   */
  onStartResearch: (
    componentId: string,
    mechanism: ResearchMechanism,
    inputs?: StartResearchInputs,
  ) => void;
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

const MECHANISM_COST_HINT: Record<ResearchMechanism, string> = {
  llm_prior: "~$0.01 per call",
  web_search: "~$0.02 per call",
  rag_document: "~$0.01 per call",
  multi_llm_consensus: "~$0.03 per call",
  ensemble_forecast: "Free (uses your forecast sidecar)",
  empirical_observation: "Free (pure CSV analysis)",
  expert_panel: "Free (no network calls)",
};

/** Mechanisms that ALWAYS need extra input before dispatch. */
const MECHANISMS_NEEDING_INPUT: ReadonlySet<ResearchMechanism> = new Set([
  "ensemble_forecast",
  "empirical_observation",
  "expert_panel",
]);

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
        {components.map((c) => (
          <ComponentResearchRow
            key={c.id}
            component={c}
            bundle={bundles[c.id]}
            inFlightMechanism={inFlight[c.id]}
            accepted={accepted[c.id] === true}
            phase={phase}
            isBusy={isBusy}
            onStartResearch={onStartResearch}
            onAcceptResearch={onAcceptResearch}
          />
        ))}
      </ul>
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

// ---------------------------------------------------------------------------
// Per-component row
// ---------------------------------------------------------------------------

interface ComponentResearchRowProps {
  component: ProposedComponent;
  bundle?: ResearchBundle;
  inFlightMechanism?: ResearchMechanism;
  accepted: boolean;
  phase: "researching" | "reviewing";
  isBusy: boolean;
  onStartResearch: (
    componentId: string,
    mechanism: ResearchMechanism,
    inputs?: StartResearchInputs,
  ) => void;
  onAcceptResearch: (componentId: string) => void;
}

function ComponentResearchRow({
  component,
  bundle,
  inFlightMechanism,
  accepted,
  phase,
  isBusy,
  onStartResearch,
  onAcceptResearch,
}: ComponentResearchRowProps) {
  // `formMechanism` holds the mechanism whose input form is currently
  // open. Null when no form is open (the row shows the picker buttons).
  const [formMechanism, setFormMechanism] = useState<ResearchMechanism | null>(
    null,
  );

  const status = accepted
    ? "accepted"
    : bundle
      ? "research received"
      : inFlightMechanism
        ? "researching..."
        : "not yet researched";

  const handlePickMechanism = (mechanism: ResearchMechanism) => {
    if (MECHANISMS_NEEDING_INPUT.has(mechanism)) {
      setFormMechanism(mechanism);
      return;
    }
    onStartResearch(component.id, mechanism);
  };

  const handleSubmitInputs = (
    mechanism: ResearchMechanism,
    inputs: StartResearchInputs,
  ) => {
    setFormMechanism(null);
    onStartResearch(component.id, mechanism, inputs);
  };

  return (
    <li className="rounded border border-[#1e293b] bg-[#0a0e1a] p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-semibold text-[#e2e8f0]">
            {component.name}
          </p>
          <p className="text-[11px] text-[#94a3b8]">{component.description}</p>
          {component.suggestedDistribution && (
            <p className="text-[10px] uppercase tracking-wide text-[#64748b]">
              Suggested: {plainDistributionLabel(component.suggestedDistribution)}
            </p>
          )}
          <p className="text-[11px] text-[#cbd5e1]">
            Status: <span className="font-medium">{status}</span>
            {inFlightMechanism && !bundle && (
              <span className="ml-2 italic text-[#64748b]">
                Mechanism: {MECHANISM_LABEL[inFlightMechanism]}
              </span>
            )}
          </p>
        </div>
        {accepted && (
          <span className="shrink-0 rounded bg-[#1e293b] px-2 py-1 text-[11px] font-semibold text-[#10b981]">
            Accepted
          </span>
        )}
      </div>

      {bundle && (
        <BundleReadout
          bundle={bundle}
          accepted={accepted}
          isBusy={isBusy}
          showAcceptCta={phase === "reviewing" && !accepted}
          onAccept={() => onAcceptResearch(component.id)}
        />
      )}

      {phase === "researching" && !bundle && !inFlightMechanism && (
        <>
          {formMechanism ? (
            <MechanismInputForm
              mechanism={formMechanism}
              defaultDistribution={component.suggestedDistribution}
              isBusy={isBusy}
              onCancel={() => setFormMechanism(null)}
              onSubmit={(inputs) => handleSubmitInputs(formMechanism, inputs)}
            />
          ) : (
            <MechanismPicker
              isBusy={isBusy}
              onPick={handlePickMechanism}
            />
          )}
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Mechanism picker (row of buttons)
// ---------------------------------------------------------------------------

interface MechanismPickerProps {
  isBusy: boolean;
  onPick: (mechanism: ResearchMechanism) => void;
}

function MechanismPicker({ isBusy, onPick }: MechanismPickerProps) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {(Object.keys(MECHANISM_LABEL) as ResearchMechanism[]).map((m) => (
        <button
          key={m}
          type="button"
          disabled={isBusy}
          onClick={() => onPick(m)}
          className="flex flex-col items-start rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1.5 text-left text-[11px] text-[#e2e8f0] hover:border-[#3b82f6] disabled:opacity-50"
        >
          <span className="font-medium">{MECHANISM_LABEL[m]}</span>
          <span className="mt-0.5 text-[10px] text-[#64748b]">
            {MECHANISM_COST_HINT[m]}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bundle readout (reasoning + citations + accept CTA)
// ---------------------------------------------------------------------------

interface BundleReadoutProps {
  bundle: ResearchBundle;
  accepted: boolean;
  isBusy: boolean;
  showAcceptCta: boolean;
  onAccept: () => void;
}

function BundleReadout({
  bundle,
  accepted,
  isBusy,
  showAcceptCta,
  onAccept,
}: BundleReadoutProps) {
  return (
    <div className="rounded bg-[#1e293b] p-2 text-[11px] text-[#cbd5e1] space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-[#64748b]">
        {MECHANISM_LABEL[bundle.mechanism]}
      </p>
      <p className="font-medium text-[#e2e8f0]">
        Suggests: {plainDistributionLabel(bundle.proposedDistribution)}
      </p>
      <ParamsReadout
        distribution={bundle.proposedDistribution}
        params={bundle.proposedParams}
      />
      <p>{bundle.reasoning}</p>
      {bundle.citations && bundle.citations.length > 0 && (
        <CitationsList citations={bundle.citations} />
      )}
      {showAcceptCta && !accepted && (
        <button
          type="button"
          onClick={onAccept}
          disabled={isBusy}
          className="rounded bg-[#10b981] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#059669] disabled:opacity-50"
        >
          Accept this research
        </button>
      )}
    </div>
  );
}

function ParamsReadout({
  distribution,
  params,
}: {
  distribution: SemanticDistribution;
  params: ResearchBundle["proposedParams"];
}) {
  const entries: string[] = [];
  if (distribution === "normal" || distribution === "lognormal") {
    if (params.mean !== undefined) entries.push(`central=${params.mean}`);
    if (params.sd !== undefined) entries.push(`spread=${params.sd}`);
  } else if (distribution === "beta") {
    if (params.alpha !== undefined) entries.push(`alpha=${params.alpha}`);
    if (params.beta !== undefined) entries.push(`beta=${params.beta}`);
  } else if (distribution === "uniform") {
    if (params.min !== undefined) entries.push(`min=${params.min}`);
    if (params.max !== undefined) entries.push(`max=${params.max}`);
  } else if (distribution === "triangular") {
    if (params.min !== undefined) entries.push(`min=${params.min}`);
    if (params.mode !== undefined) entries.push(`most-likely=${params.mode}`);
    if (params.max !== undefined) entries.push(`max=${params.max}`);
  }
  if (entries.length === 0) return null;
  return (
    <p className="text-[10px] text-[#94a3b8]">
      Parameters: {entries.join(", ")}
    </p>
  );
}

function CitationsList({ citations }: { citations: ResearchCitation[] }) {
  return (
    <ul className="space-y-1 border-t border-[#0f1629] pt-1">
      {citations.map((c, i) => (
        <li key={i} className="text-[10px] text-[#94a3b8]">
          <span className="text-[#64748b]">[{i + 1}]</span>{" "}
          {c.url ? (
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[#60a5fa] underline-offset-2 hover:underline"
            >
              {c.title || c.url}
            </a>
          ) : c.sourceFilename ? (
            <span className="italic">{c.sourceFilename}</span>
          ) : c.source ? (
            <span className="italic">{c.source}</span>
          ) : (
            <span className="italic">(unnamed source)</span>
          )}
          {c.snippet && (
            <span className="ml-1 text-[#cbd5e1]">— {c.snippet}</span>
          )}
          {c.chunkText && !c.snippet && (
            <span className="ml-1 text-[#cbd5e1]">— {c.chunkText}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Mechanism input forms
// ---------------------------------------------------------------------------

interface MechanismInputFormProps {
  mechanism: ResearchMechanism;
  defaultDistribution?: SemanticDistribution;
  isBusy: boolean;
  onCancel: () => void;
  onSubmit: (inputs: StartResearchInputs) => void;
}

function MechanismInputForm(props: MechanismInputFormProps) {
  switch (props.mechanism) {
    case "ensemble_forecast":
      return <ForecastInputsForm {...props} />;
    case "empirical_observation":
      return <EmpiricalInputsForm {...props} />;
    case "expert_panel":
      return <ExpertPanelInputsForm {...props} />;
    default:
      return null;
  }
}

/**
 * Parse a CSV string with a header row into rows of column→string. Bare
 * minimum implementation — no quoted-field handling, no escaping —
 * because the no-mock contract means we test against real CSV strings
 * and a quoted-field shape would need a real parser. Real-Data Mode has
 * a Papa Parse client elsewhere; we deliberately stay simple here and
 * let the user paste pre-cleaned CSV.
 */
function parseSimpleCsv(
  csvText: string,
): Array<Record<string, string>> {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (cells[j] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function FormScaffold({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
}) {
  return (
    <div className="rounded border border-[#3b82f6] bg-[#0f1629] p-2 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[#e2e8f0]">{title}</p>
        <button
          type="button"
          onClick={onCancel}
          className="text-[10px] text-[#64748b] underline-offset-2 hover:text-[#94a3b8] hover:underline"
        >
          Cancel
        </button>
      </div>
      {children}
    </div>
  );
}

function CsvUploadField({
  csvText,
  setCsvText,
  fileError,
  setFileError,
}: {
  csvText: string;
  setCsvText: (v: string) => void;
  fileError: string | null;
  setFileError: (v: string | null) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-[#94a3b8]">
        Paste CSV (header row required), or load a .csv file
      </span>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            const text = await file.text();
            setCsvText(text);
            setFileError(null);
          } catch (err) {
            setFileError(
              err instanceof Error ? err.message : "Failed to read file",
            );
          }
        }}
        className="block w-full text-[10px] text-[#94a3b8]"
      />
      <textarea
        value={csvText}
        onChange={(e) => setCsvText(e.target.value)}
        rows={6}
        placeholder="date,value&#10;2026-01-01,100&#10;2026-02-01,103"
        className="block w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1.5 text-[10px] font-mono text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
      />
      {fileError && (
        <p className="text-[10px] text-red-400" role="alert">
          {fileError}
        </p>
      )}
    </label>
  );
}

function ForecastInputsForm({
  isBusy,
  onCancel,
  onSubmit,
}: MechanismInputFormProps) {
  const [csvText, setCsvText] = useState("");
  const [dateColumn, setDateColumn] = useState("");
  const [targetColumn, setTargetColumn] = useState("");
  const [horizon, setHorizon] = useState<1 | 2 | 3>(1);
  const [fileError, setFileError] = useState<string | null>(null);

  const detectedColumns = useMemo(() => {
    const rows = parseSimpleCsv(csvText);
    if (rows.length === 0) return [] as string[];
    return Object.keys(rows[0]);
  }, [csvText]);

  const handleSubmit = () => {
    const rows = parseSimpleCsv(csvText);
    if (rows.length === 0) {
      setFileError("CSV must include a header row and at least one data row.");
      return;
    }
    if (!dateColumn) {
      setFileError("Pick a date column.");
      return;
    }
    if (!targetColumn) {
      setFileError("Pick a target column.");
      return;
    }
    onSubmit({
      csvRows: rows,
      dateColumn,
      targetColumn,
      horizon,
    });
  };

  return (
    <FormScaffold title="Forecast Mode inputs" onCancel={onCancel}>
      <CsvUploadField
        csvText={csvText}
        setCsvText={setCsvText}
        fileError={fileError}
        setFileError={setFileError}
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-[10px] text-[#94a3b8]">Date column</span>
          <select
            value={dateColumn}
            onChange={(e) => setDateColumn(e.target.value)}
            className="block w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1 text-[11px] text-[#e2e8f0]"
          >
            <option value="">(pick one)</option>
            {detectedColumns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] text-[#94a3b8]">Target column</span>
          <select
            value={targetColumn}
            onChange={(e) => setTargetColumn(e.target.value)}
            className="block w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1 text-[11px] text-[#e2e8f0]"
          >
            <option value="">(pick one)</option>
            {detectedColumns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] text-[#94a3b8]">Horizon (steps)</span>
          <select
            value={horizon}
            onChange={(e) =>
              setHorizon(Number(e.target.value) as 1 | 2 | 3)
            }
            className="block w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1 text-[11px] text-[#e2e8f0]"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={isBusy}
        className="rounded bg-[#3b82f6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:opacity-50"
      >
        Run forecast research
      </button>
    </FormScaffold>
  );
}

function EmpiricalInputsForm({
  isBusy,
  onCancel,
  onSubmit,
}: MechanismInputFormProps) {
  const [csvText, setCsvText] = useState("");
  const [targetColumn, setTargetColumn] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  const detectedColumns = useMemo(() => {
    const rows = parseSimpleCsv(csvText);
    if (rows.length === 0) return [] as string[];
    return Object.keys(rows[0]);
  }, [csvText]);

  const handleSubmit = () => {
    const rows = parseSimpleCsv(csvText);
    if (rows.length === 0) {
      setFileError("CSV must include a header row and at least one data row.");
      return;
    }
    if (!targetColumn) {
      setFileError("Pick a target column.");
      return;
    }
    onSubmit({ csvRows: rows, targetColumn });
  };

  return (
    <FormScaffold title="Real Data Mode inputs" onCancel={onCancel}>
      <CsvUploadField
        csvText={csvText}
        setCsvText={setCsvText}
        fileError={fileError}
        setFileError={setFileError}
      />
      <label className="block space-y-1">
        <span className="text-[10px] text-[#94a3b8]">Target column</span>
        <select
          value={targetColumn}
          onChange={(e) => setTargetColumn(e.target.value)}
          className="block w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1 text-[11px] text-[#e2e8f0]"
        >
          <option value="">(pick one)</option>
          {detectedColumns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={isBusy}
        className="rounded bg-[#3b82f6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:opacity-50"
      >
        Run real-data research
      </button>
    </FormScaffold>
  );
}

function ExpertPanelInputsForm({
  defaultDistribution,
  isBusy,
  onCancel,
  onSubmit,
}: MechanismInputFormProps) {
  const [rows, setRows] = useState<Array<{ label: string; value: string }>>([
    { label: "", value: "" },
    { label: "", value: "" },
  ]);
  const [distribution, setDistribution] = useState<SemanticDistribution>(
    defaultDistribution ?? "normal",
  );
  const [formError, setFormError] = useState<string | null>(null);

  const handleRowChange = (
    index: number,
    field: "label" | "value",
    value: string,
  ) => {
    setRows((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleAdd = () =>
    setRows((prev) => [...prev, { label: "", value: "" }]);
  const handleRemove = (index: number) =>
    setRows((prev) => prev.filter((_, i) => i !== index));

  const handleSubmit = () => {
    const estimates: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const trimmed = rows[i].value.trim();
      if (trimmed === "") continue;
      const num = Number(trimmed);
      if (!Number.isFinite(num)) {
        setFormError(`Estimate #${i + 1} ("${trimmed}") is not a number.`);
        return;
      }
      estimates.push(num);
      labels.push(rows[i].label.trim() || `expert-${i + 1}`);
    }
    if (estimates.length < 2) {
      setFormError("Need at least 2 numeric estimates.");
      return;
    }
    onSubmit({ estimates, labels, distribution });
  };

  return (
    <FormScaffold title="Expert panel estimates" onCancel={onCancel}>
      <p className="text-[10px] text-[#94a3b8]">
        Enter 2 or more point estimates. Disagreement across experts
        becomes the variance &mdash; that is the honest answer.
      </p>
      <ul className="space-y-1">
        {rows.map((row, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              type="text"
              placeholder={`label (optional)`}
              value={row.label}
              onChange={(e) => handleRowChange(i, "label", e.target.value)}
              className="flex-1 rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1 text-[11px] text-[#e2e8f0]"
            />
            <input
              type="number"
              step="any"
              placeholder="estimate"
              value={row.value}
              onChange={(e) => handleRowChange(i, "value", e.target.value)}
              className="w-32 rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1 text-[11px] text-[#e2e8f0]"
            />
            {rows.length > 2 && (
              <button
                type="button"
                onClick={() => handleRemove(i)}
                className="text-[10px] text-[#94a3b8] hover:text-red-400"
                aria-label={`Remove estimate ${i + 1}`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleAdd}
          className="rounded border border-[#1e293b] px-2 py-1 text-[10px] text-[#94a3b8] hover:text-white"
        >
          Add estimate
        </button>
        <label className="ml-auto text-[10px] text-[#94a3b8]">
          Distribution:
          <select
            value={distribution}
            onChange={(e) =>
              setDistribution(e.target.value as SemanticDistribution)
            }
            className="ml-1 rounded border border-[#1e293b] bg-[#0a0e1a] px-1 py-0.5 text-[11px] text-[#e2e8f0]"
          >
            <option value="normal">normal</option>
            <option value="lognormal">lognormal</option>
            <option value="beta">beta</option>
            <option value="uniform">uniform</option>
            <option value="triangular">triangular</option>
          </select>
        </label>
      </div>
      {formError && (
        <p className="text-[10px] text-red-400" role="alert">
          {formError}
        </p>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={isBusy}
        className="rounded bg-[#3b82f6] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:opacity-50"
      >
        Run expert-panel research
      </button>
    </FormScaffold>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plainDistributionLabel(d: SemanticDistribution): string {
  switch (d) {
    case "beta":
      return "bounded between 0 and 1 (probabilities / fractions)";
    case "normal":
      return "symmetric around a central value";
    case "lognormal":
      return "right-skewed (costs, durations, sizes)";
    case "uniform":
      return "flat between a min and a max";
    case "triangular":
      return "bounded with a most-likely value (best/likely/worst)";
  }
}

export default ResearchStep;
