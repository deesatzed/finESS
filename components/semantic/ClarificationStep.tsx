"use client";

/**
 * ClarificationStep — renders the LLM's clarifying questions (state
 * AWAITING_ANSWERS) with one text input per question. Local component
 * state holds the in-flight answer text so typing is instant; on
 * Submit, the parent panel dispatches `submitClarifications` through
 * the API. Each per-question save round-trips through the server via
 * `answerClarification` so the persisted state stays the source of
 * truth.
 *
 * Plain-language only — no statistical vocabulary in this surface.
 * The "why" tooltip from each question is rendered verbatim so the
 * user understands what the answer will influence.
 */
import { useState } from "react";
import type {
  ClarifyingQuestion,
} from "@/lib/semantic/types";

interface ClarificationStepProps {
  questions: ClarifyingQuestion[];
  answers: Record<string, string>;
  isBusy: boolean;
  onAnswerChange: (qId: string, answer: string) => void;
  onSubmit: () => void;
  onBack?: () => void;
  onReset: () => void;
}

export function ClarificationStep({
  questions,
  answers,
  isBusy,
  onAnswerChange,
  onSubmit,
  onBack,
  onReset,
}: ClarificationStepProps) {
  const [pending, setPending] = useState<Record<string, string>>({});

  const valueFor = (qId: string) =>
    pending[qId] !== undefined ? pending[qId] : (answers[qId] ?? "");

  const commitAnswer = (qId: string, value: string) => {
    if (value === (answers[qId] ?? "")) return;
    onAnswerChange(qId, value);
  };

  const answeredCount = questions.filter(
    (q) => (valueFor(q.id) ?? "").trim().length > 0,
  ).length;

  return (
    <section
      aria-labelledby="clarify-heading"
      className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 space-y-3"
    >
      <header className="flex items-center justify-between">
        <h2
          id="clarify-heading"
          className="text-sm font-semibold text-[#e2e8f0]"
        >
          Step 1 &mdash; Clarifying questions
        </h2>
        <span className="text-[11px] text-[#64748b]">
          {answeredCount} of {questions.length} answered
        </span>
      </header>
      <p className="text-xs text-[#94a3b8]">
        Answer as much or as little as you can. Wide unknowns are fine
        &mdash; the model treats them as uncertainty, not error.
      </p>
      <ol className="space-y-3">
        {questions.map((q) => (
          <li
            key={q.id}
            className="rounded border border-[#1e293b] bg-[#0a0e1a] p-3"
          >
            <label
              htmlFor={`clarify-${q.id}`}
              className="block text-xs font-medium text-[#e2e8f0]"
            >
              {q.question}
            </label>
            {q.why && (
              <p className="mt-1 text-[11px] italic text-[#64748b]">
                Why we ask: {q.why}
              </p>
            )}
            <textarea
              id={`clarify-${q.id}`}
              value={valueFor(q.id)}
              placeholder={q.defaultAnswer ?? "Type your answer..."}
              disabled={isBusy}
              rows={2}
              className="mt-2 w-full rounded border border-[#1e293b] bg-[#0f1629] px-2 py-1 text-xs text-[#e2e8f0] placeholder:text-[#475569] focus:border-[#3b82f6] focus:outline-none"
              onChange={(e) => {
                setPending((p) => ({ ...p, [q.id]: e.target.value }));
              }}
              onBlur={(e) => commitAnswer(q.id, e.target.value)}
            />
            {q.defaultAnswer && (
              <button
                type="button"
                className="mt-1 text-[11px] text-[#3b82f6] underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isBusy}
                onClick={() => {
                  setPending((p) => ({ ...p, [q.id]: q.defaultAnswer ?? "" }));
                  commitAnswer(q.id, q.defaultAnswer ?? "");
                }}
              >
                Use suggested answer
              </button>
            )}
          </li>
        ))}
      </ol>
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
          onClick={onSubmit}
          disabled={isBusy}
          className="rounded bg-[#3b82f6] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isBusy ? "Working..." : "Continue"}
        </button>
      </footer>
    </section>
  );
}

export default ClarificationStep;
