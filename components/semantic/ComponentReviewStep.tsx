"use client";

/**
 * ComponentReviewStep — REVIEWING_COMPONENTS step. Lists every
 * proposed component with name, description, suggested distribution
 * (plain-language label by default; raw enum behind a "Show details"
 * disclosure), why it matters, and dependsOn relationships. Per-row
 * "Edit" toggles an inline form that dispatches `editComponent` on
 * blur. Accept-all advances to SETTING_THRESHOLD.
 *
 * Non-statistical UX commitment: distribution names are shown as
 * plain-language phrases. The raw enum (normal / beta / lognormal /
 * triangular / uniform) appears only in the disclosure block.
 */
import { useState } from "react";
import type {
  ComponentPatch,
  ProposedComponent,
  SemanticDistribution,
} from "@/lib/semantic/types";

interface ComponentReviewStepProps {
  components: ProposedComponent[];
  isBusy: boolean;
  onEdit: (componentId: string, patch: ComponentPatch) => void;
  onAccept: () => void;
  onBack?: () => void;
  onReset: () => void;
}

const DISTRIBUTION_PLAIN_LABEL: Record<SemanticDistribution, string> = {
  normal: "bell curve around a central estimate",
  beta: "bounded between 0 and 1 (a rate or probability)",
  uniform: "anywhere in a flat range",
  lognormal: "skewed right (long tail above the central value)",
  triangular: "most-likely value with bounded extremes",
};

export function ComponentReviewStep({
  components,
  isBusy,
  onEdit,
  onAccept,
  onBack,
  onReset,
}: ComponentReviewStepProps) {
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <section
      aria-labelledby="components-heading"
      className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 space-y-3"
    >
      <header className="flex items-center justify-between">
        <h2
          id="components-heading"
          className="text-sm font-semibold text-[#e2e8f0]"
        >
          Step 2 &mdash; Key uncertain components
        </h2>
        <span className="text-[11px] text-[#64748b]">
          {components.length} proposed
        </span>
      </header>
      <p className="text-xs text-[#94a3b8]">
        These are the factors the model will reason about. Edit any of
        them &mdash; the rest of the pipeline runs on this list.
      </p>
      <ul className="space-y-2">
        {components.map((c) => {
          const isEditing = editingId === c.id;
          const isOpen = openDetails[c.id] === true;
          return (
            <li
              key={c.id}
              className="rounded border border-[#1e293b] bg-[#0a0e1a] p-3"
            >
              {isEditing ? (
                <EditComponentForm
                  component={c}
                  onSave={(patch) => {
                    onEdit(c.id, patch);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[#e2e8f0]">
                      {c.name}
                    </p>
                    <p className="mt-1 text-[11px] text-[#94a3b8]">
                      {c.description}
                    </p>
                    {c.why && (
                      <p className="mt-1 text-[11px] italic text-[#64748b]">
                        {c.why}
                      </p>
                    )}
                    <p className="mt-2 text-[11px] text-[#cbd5e1]">
                      Shape:{" "}
                      <span className="font-medium">
                        {c.suggestedDistribution
                          ? DISTRIBUTION_PLAIN_LABEL[c.suggestedDistribution]
                          : "not yet chosen"}
                      </span>
                    </p>
                    {c.dependsOn && c.dependsOn.length > 0 && (
                      <p className="mt-1 text-[11px] text-[#64748b]">
                        Depends on: {c.dependsOn.join(", ")}
                      </p>
                    )}
                    <button
                      type="button"
                      className="mt-2 text-[10px] uppercase tracking-wider text-[#475569] underline-offset-2 hover:text-[#94a3b8] hover:underline"
                      onClick={() =>
                        setOpenDetails((p) => ({ ...p, [c.id]: !isOpen }))
                      }
                    >
                      {isOpen ? "Hide distribution details" : "Show distribution details"}
                    </button>
                    {isOpen && (
                      <pre className="mt-1 overflow-x-auto rounded bg-[#1e293b] p-2 text-[10px] text-[#94a3b8]">
                        {JSON.stringify(
                          {
                            id: c.id,
                            suggestedDistribution: c.suggestedDistribution,
                            dependsOn: c.dependsOn ?? [],
                          },
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingId(c.id)}
                    disabled={isBusy}
                    className="shrink-0 rounded border border-[#1e293b] px-2 py-1 text-[11px] text-[#94a3b8] hover:text-white disabled:opacity-50"
                  >
                    Edit
                  </button>
                </div>
              )}
            </li>
          );
        })}
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
        <button
          type="button"
          onClick={onAccept}
          disabled={isBusy || components.length === 0}
          className="rounded bg-[#3b82f6] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Accept all components
        </button>
      </footer>
    </section>
  );
}

interface EditFormProps {
  component: ProposedComponent;
  onSave: (patch: ComponentPatch) => void;
  onCancel: () => void;
}

function EditComponentForm({ component, onSave, onCancel }: EditFormProps) {
  const [name, setName] = useState(component.name);
  const [description, setDescription] = useState(component.description);
  const [why, setWhy] = useState(component.why ?? "");
  const [dist, setDist] = useState<SemanticDistribution | "">(
    component.suggestedDistribution ?? "",
  );

  return (
    <div className="space-y-2">
      <label className="block text-[11px] text-[#94a3b8]">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1 text-xs text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
        />
      </label>
      <label className="block text-[11px] text-[#94a3b8]">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1 text-xs text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
        />
      </label>
      <label className="block text-[11px] text-[#94a3b8]">
        Why it matters
        <textarea
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          rows={1}
          className="mt-1 w-full rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1 text-xs text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
        />
      </label>
      <label className="block text-[11px] text-[#94a3b8]">
        Distribution shape
        <select
          value={dist}
          onChange={(e) =>
            setDist((e.target.value as SemanticDistribution) || "")
          }
          className="mt-1 w-full rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1 text-xs text-[#e2e8f0] focus:border-[#3b82f6] focus:outline-none"
        >
          <option value="">(unchanged)</option>
          {(Object.keys(DISTRIBUTION_PLAIN_LABEL) as SemanticDistribution[]).map(
            (d) => (
              <option key={d} value={d}>
                {DISTRIBUTION_PLAIN_LABEL[d]}
              </option>
            ),
          )}
        </select>
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[#1e293b] px-3 py-1 text-[11px] text-[#94a3b8] hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            const patch: ComponentPatch = {};
            if (name.trim() && name !== component.name) patch.name = name;
            if (description !== component.description) patch.description = description;
            if (why !== (component.why ?? "")) patch.why = why;
            if (dist && dist !== component.suggestedDistribution) {
              patch.suggestedDistribution = dist;
            }
            onSave(patch);
          }}
          className="rounded bg-[#3b82f6] px-3 py-1 text-[11px] font-semibold text-white hover:bg-[#2563eb]"
        >
          Save
        </button>
      </div>
    </div>
  );
}

export default ComponentReviewStep;
