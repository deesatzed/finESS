"use client";

/**
 * SemanticPanel — top-level container for the Semantic Mode (5th tab).
 *
 * Owns:
 *  - The current PersistedSemanticConversation (server is source of truth).
 *  - The narration history built by narrationFor() after each event.
 *  - The "start" affordance when no conversation has been created.
 *  - Routing to the appropriate step component based on state.kind.
 *  - The cockpit handoff: when state.kind hits REVIEWING_RESULT or
 *    COMPLETE, render the cockpit (Dashboard slot) inline with the
 *    history rail collapsed to a left side panel.
 *
 * Cockpit handoff approach (per A5 brief): we mount the cockpit as a
 * CHILD of SemanticPanel via the `renderCockpit` prop rather than
 * touching Dashboard.tsx. Dashboard's existing prop surface is rich
 * enough that re-using it here just requires the parent to wire the
 * panels; the SemanticPanel itself is mostly chrome. This avoids any
 * Dashboard.tsx changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PersistedSemanticConversation,
} from "@/lib/semantic/persistence";
import type {
  SemanticEvent,
  SemanticState,
  StartResearchInputs,
} from "@/lib/semantic/state-machine";
import type {
  ComponentPatch,
  ModelRunResult,
  ResearchMechanism,
} from "@/lib/semantic/types";
import {
  buildNarrationEntry,
  type NarrationEntry,
} from "@/lib/semantic/narration";
import {
  createConversation,
  dispatchEvent as dispatchServerEvent,
  SemanticApiError,
  SemanticReducerError,
} from "@/lib/semantic/api-client";
import { SemanticHonestyBanner } from "@/components/semantic/SemanticHonestyBanner";
import { SemanticHistory } from "@/components/semantic/SemanticHistory";
import { ClarificationStep } from "@/components/semantic/ClarificationStep";
import { ComponentReviewStep } from "@/components/semantic/ComponentReviewStep";
import { ThresholdStep } from "@/components/semantic/ThresholdStep";
import { ResearchStep } from "@/components/semantic/ResearchStep";
import { ResultStep } from "@/components/semantic/ResultStep";

interface SemanticPanelProps {
  /**
   * Render the cockpit (6-panel Dashboard) given the model result. The
   * parent provides this so SemanticPanel does not have to import the
   * full Dashboard pipeline. Returns null until result is ready.
   */
  renderCockpit?: (
    state: SemanticState & { kind: "REVIEWING_RESULT" | "COMPLETE" },
  ) => React.ReactNode;
  /**
   * Optional pre-seeded conversation (used by tests). Production
   * usage starts from `null` and lets the user create one.
   */
  initialConversation?: PersistedSemanticConversation | null;
  /**
   * Optional pre-seeded narration history (used by tests).
   */
  initialNarration?: NarrationEntry[];
}

export function SemanticPanel({
  renderCockpit,
  initialConversation = null,
  initialNarration = [],
}: SemanticPanelProps) {
  const [conversation, setConversation] =
    useState<PersistedSemanticConversation | null>(initialConversation);
  const [narration, setNarration] =
    useState<NarrationEntry[]>(initialNarration);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftQuery, setDraftQuery] = useState("");
  const narrationIndex = useRef(initialNarration.length);

  const appendNarration = useCallback(
    (prev: SemanticState, event: SemanticEvent, next: SemanticState) => {
      const entry = buildNarrationEntry(
        narrationIndex.current,
        prev,
        event,
        next,
      );
      narrationIndex.current += 1;
      setNarration((prevList) => [...prevList, entry]);
    },
    [],
  );

  const handleApiError = useCallback((err: unknown) => {
    if (err instanceof SemanticReducerError) {
      setError(
        "That step is no longer valid in this conversation. Use Back or Start over.",
      );
    } else if (err instanceof SemanticApiError) {
      setError(err.message);
    } else if (err instanceof Error) {
      setError(err.message);
    } else {
      setError("Unknown error.");
    }
  }, []);

  const dispatch = useCallback(
    async (event: SemanticEvent) => {
      if (!conversation) {
        setError("No active conversation. Create one first.");
        return;
      }
      const prevState = conversation.state;
      setIsBusy(true);
      setError(null);
      try {
        const updated = await dispatchServerEvent(conversation.id, event);
        setConversation(updated);
        appendNarration(prevState, event, updated.state);
      } catch (err) {
        handleApiError(err);
      } finally {
        setIsBusy(false);
      }
    },
    [conversation, appendNarration, handleApiError],
  );

  const handleStart = useCallback(async () => {
    if (draftQuery.trim().length === 0) {
      setError("Type a question to start a conversation.");
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const created = await createConversation(draftQuery.trim());
      setConversation(created);
      // The server starts us in CLARIFYING already (POST advances from
      // IDLE via the reducer). Narrate that initial transition.
      appendNarration({ kind: "IDLE" }, { type: "start", query: draftQuery.trim() }, created.state);
      setDraftQuery("");
    } catch (err) {
      handleApiError(err);
    } finally {
      setIsBusy(false);
    }
  }, [draftQuery, appendNarration, handleApiError]);

  // Convenience dispatch helpers for each step.
  const handleAnswer = (qId: string, answer: string) =>
    dispatch({ type: "answerClarification", qId, answer });
  const handleSubmitClarifications = () =>
    dispatch({ type: "submitClarifications" });
  const handleEditComponent = (componentId: string, patch: ComponentPatch) =>
    dispatch({ type: "editComponent", componentId, patch });
  const handleAcceptComponents = () => dispatch({ type: "acceptComponents" });
  const handleSetThreshold = (threshold: number, thresholdLabel: string) =>
    dispatch({ type: "setThreshold", threshold, thresholdLabel });
  /**
   * B6: ResearchStep may attach mechanism-specific inputs (CSV, expert
   * estimates) when the user picks ensemble_forecast / empirical /
   * expert_panel. The dispatcher forwards them on the wire; the
   * reducer ignores them; the server-side auto-advance reads them.
   * Mechanisms that need no inputs pass `inputs` undefined and the
   * server takes the no-input path.
   */
  const handleStartResearch = (
    componentId: string,
    mechanism: ResearchMechanism,
    inputs?: StartResearchInputs,
  ) =>
    dispatch(
      inputs && Object.keys(inputs).length > 0
        ? { type: "startResearch", componentId, mechanism, inputs }
        : { type: "startResearch", componentId, mechanism },
    );
  const handleAcceptResearch = (componentId: string) =>
    dispatch({ type: "acceptResearch", componentId });
  const handleRunModel = () => dispatch({ type: "runModel" });
  const handleVerifyNext = (componentId: string) =>
    dispatch({ type: "verifyNext", componentId });
  const handleAcceptResult = () => dispatch({ type: "acceptResult" });
  const handleBack = () => dispatch({ type: "back" });
  const handleReset = useCallback(() => {
    // Reset is universally allowed; if the user has a conversation we
    // dispatch reset (which moves state to IDLE), but we also clear the
    // local conversation pointer so the start screen renders again.
    if (!conversation) return;
    dispatch({ type: "reset" }).then(() => {
      setConversation(null);
      setNarration([]);
      narrationIndex.current = 0;
    });
  }, [conversation, dispatch]);

  // Auto-clear error after state changes so a stale message does not
  // shadow a fresh result.
  useEffect(() => {
    if (conversation && error === null) return;
  }, [conversation, error]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (!conversation) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        <SemanticHonestyBanner />
        <section className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 space-y-3">
          <h2 className="text-sm font-semibold text-[#e2e8f0]">
            Start a semantic conversation
          </h2>
          <p className="text-xs text-[#94a3b8]">
            Ask a real question. The system will not jump straight to a
            number &mdash; it will ask clarifying questions, surface the
            uncertain factors, and let you accept or edit at every gate.
          </p>
          <label className="block">
            <span className="text-[11px] text-[#94a3b8]">Your question</span>
            <textarea
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              rows={3}
              placeholder="e.g. What is the probability a 55-year-old with chest pain has PE?"
              disabled={isBusy}
              className="mt-1 w-full rounded border border-[#1e293b] bg-[#0a0e1a] px-2 py-1.5 text-xs text-[#e2e8f0] placeholder:text-[#475569] focus:border-[#3b82f6] focus:outline-none"
            />
          </label>
          {error && (
            <p role="alert" className="text-[11px] text-red-400">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleStart}
              disabled={isBusy || draftQuery.trim().length === 0}
              className="rounded bg-[#3b82f6] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? "Starting..." : "Start conversation"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  const state = conversation.state;
  const isCockpitPhase =
    state.kind === "REVIEWING_RESULT" || state.kind === "COMPLETE";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
      <SemanticHonestyBanner collapsed={isCockpitPhase} />
      {error && (
        <div
          role="alert"
          className="rounded border-l-4 border-red-500 bg-red-100 px-3 py-2 text-xs text-red-900"
        >
          {error}
        </div>
      )}

      {isCockpitPhase ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-3">
          <aside className="min-h-0">
            <SemanticHistory
              entries={narration}
              currentStateKind={state.kind}
              compact
            />
          </aside>
          <div className="min-h-0 flex flex-col gap-2">
            <ResultStep
              components={
                state.kind === "REVIEWING_RESULT" || state.kind === "COMPLETE"
                  ? state.components
                  : []
              }
              result={
                state.kind === "REVIEWING_RESULT" || state.kind === "COMPLETE"
                  ? state.result
                  : ({} as ModelRunResult)
              }
              threshold={
                state.kind === "REVIEWING_RESULT" || state.kind === "COMPLETE"
                  ? state.threshold
                  : 0
              }
              thresholdLabel={
                state.kind === "REVIEWING_RESULT" || state.kind === "COMPLETE"
                  ? state.thresholdLabel
                  : ""
              }
              conversationId={conversation.id}
              isComplete={state.kind === "COMPLETE"}
              isBusy={isBusy}
              cockpitSlot={
                renderCockpit
                  ? renderCockpit(
                      state as SemanticState & {
                        kind: "REVIEWING_RESULT" | "COMPLETE";
                      },
                    )
                  : null
              }
              onVerifyNext={handleVerifyNext}
              onAccept={handleAcceptResult}
              onBack={handleBack}
              onReset={handleReset}
            />
          </div>
        </div>
      ) : (
        <>
          <SemanticHistory
            entries={narration}
            currentStateKind={state.kind}
          />
          {renderStep({
            state,
            isBusy,
            handleAnswer,
            handleSubmitClarifications,
            handleEditComponent,
            handleAcceptComponents,
            handleSetThreshold,
            handleStartResearch,
            handleAcceptResearch,
            handleRunModel,
            handleBack,
            handleReset,
          })}
        </>
      )}
    </div>
  );
}

interface RenderStepArgs {
  state: SemanticState;
  isBusy: boolean;
  handleAnswer: (qId: string, answer: string) => Promise<void>;
  handleSubmitClarifications: () => Promise<void>;
  handleEditComponent: (
    componentId: string,
    patch: ComponentPatch,
  ) => Promise<void>;
  handleAcceptComponents: () => Promise<void>;
  handleSetThreshold: (threshold: number, label: string) => Promise<void>;
  handleStartResearch: (
    componentId: string,
    mechanism: ResearchMechanism,
    inputs?: StartResearchInputs,
  ) => Promise<void>;
  handleAcceptResearch: (componentId: string) => Promise<void>;
  handleRunModel: () => Promise<void>;
  handleBack: () => Promise<void>;
  handleReset: () => void;
}

function renderStep(args: RenderStepArgs): React.ReactNode {
  const { state, isBusy } = args;
  switch (state.kind) {
    case "IDLE":
    case "CLARIFYING":
      return (
        <div className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 text-xs text-[#94a3b8]">
          Thinking through what to ask you first...
        </div>
      );
    case "AWAITING_ANSWERS":
      return (
        <ClarificationStep
          questions={state.questions}
          answers={state.answers}
          isBusy={isBusy}
          onAnswerChange={args.handleAnswer}
          onSubmit={args.handleSubmitClarifications}
          onReset={args.handleReset}
        />
      );
    case "PROPOSING_COMPONENTS":
      return (
        <div className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 text-xs text-[#94a3b8]">
          Identifying the key uncertain components... this takes a
          moment.
        </div>
      );
    case "REVIEWING_COMPONENTS":
      return (
        <ComponentReviewStep
          components={state.components}
          isBusy={isBusy}
          onEdit={args.handleEditComponent}
          onAccept={args.handleAcceptComponents}
          onBack={args.handleBack}
          onReset={args.handleReset}
        />
      );
    case "SETTING_THRESHOLD":
      return (
        <ThresholdStep
          isBusy={isBusy}
          onSubmit={args.handleSetThreshold}
          onBack={args.handleBack}
          onReset={args.handleReset}
        />
      );
    case "RESEARCHING":
      return (
        <ResearchStep
          components={state.components}
          threshold={state.threshold}
          thresholdLabel={state.thresholdLabel}
          bundles={state.bundles}
          inFlight={state.inFlight}
          accepted={{}}
          phase="researching"
          isBusy={isBusy}
          onStartResearch={args.handleStartResearch}
          onAcceptResearch={args.handleAcceptResearch}
          onRunModel={args.handleRunModel}
          onReset={args.handleReset}
        />
      );
    case "REVIEWING_RESEARCH":
      return (
        <ResearchStep
          components={state.components}
          threshold={state.threshold}
          thresholdLabel={state.thresholdLabel}
          bundles={state.bundles}
          inFlight={{}}
          accepted={state.accepted}
          phase="reviewing"
          isBusy={isBusy}
          onStartResearch={args.handleStartResearch}
          onAcceptResearch={args.handleAcceptResearch}
          onRunModel={args.handleRunModel}
          onBack={args.handleBack}
          onReset={args.handleReset}
        />
      );
    case "MODELING":
      return (
        <div className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 text-xs text-[#94a3b8]">
          Running the Monte Carlo over your full uncertainty model...
          watch the cockpit fill in once it completes.
        </div>
      );
    case "ERROR":
      return (
        <div className="rounded-md border-l-4 border-red-500 bg-red-100 p-4 text-xs text-red-900">
          <p className="font-semibold">Something went wrong:</p>
          <p className="mt-1">{state.message}</p>
          <button
            type="button"
            onClick={args.handleBack}
            disabled={isBusy}
            className="mt-2 rounded border border-red-500 px-3 py-1 text-[11px] font-semibold text-red-900 hover:bg-red-200 disabled:opacity-50"
          >
            Back
          </button>
        </div>
      );
    default:
      return null;
  }
}

export default SemanticPanel;
