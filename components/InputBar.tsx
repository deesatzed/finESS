"use client";

import { useState, useRef } from "react";
import { EXAMPLE_SCENARIOS } from "@/lib/examples/example-queries";

interface InputBarProps {
  onSubmit: (query: string) => void;
  isLoading: boolean;
  onRunExample: () => void;
}

export function InputBar({ onSubmit, isLoading, onRunExample }: InputBarProps) {
  const [query, setQuery] = useState("");
  const [showExamples, setShowExamples] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (trimmed && !isLoading) {
      onSubmit(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleExampleSelect = (scenario: typeof EXAMPLE_SCENARIOS[0]) => {
    if (scenario.id === "pe_clinical") {
      onRunExample();
    } else {
      setQuery(scenario.query);
    }
    setShowExamples(false);
  };

  return (
    <div className="w-full px-4 py-3 bg-[#0f1629] border-t border-[#1e293b] relative">
      {/* Example scenarios dropdown */}
      {showExamples && (
        <div className="absolute bottom-full left-4 right-4 mb-1 bg-[#1e293b] rounded-lg border border-[#334155] shadow-xl max-w-4xl mx-auto overflow-hidden animate-fade-in">
          <div className="px-3 py-2 border-b border-[#334155]">
            <span className="text-xs text-[#64748b]">Example Scenarios</span>
          </div>
          {EXAMPLE_SCENARIOS.map((scenario) => (
            <button
              key={scenario.id}
              onClick={() => handleExampleSelect(scenario)}
              disabled={isLoading}
              className="w-full text-left px-3 py-2 hover:bg-[#2d3a50] transition-colors border-b border-[#334155] last:border-b-0 disabled:opacity-40"
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#334155] text-[#94a3b8]">
                  {scenario.domain}
                </span>
                <span className="text-xs text-white">{scenario.title}</span>
                {scenario.id === "pe_clinical" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#3b82f6]/20 text-[#3b82f6]">
                    Instant
                  </span>
                )}
              </div>
              <p className="text-[10px] text-[#64748b] mt-1 line-clamp-1">
                {scenario.query}
              </p>
            </button>
          ))}
        </div>
      )}

      <div className="max-w-4xl mx-auto flex gap-3 items-end">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your decision problem in plain language..."
            className="w-full bg-[#1e293b] text-[#e2e8f0] rounded-lg px-4 py-3 pr-12 resize-none focus:outline-none focus:ring-2 focus:ring-[#3b82f6] placeholder-[#475569] text-sm"
            rows={2}
            disabled={isLoading}
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={isLoading || !query.trim()}
          className="px-6 py-3 bg-[#3b82f6] text-white rounded-lg font-medium text-sm hover:bg-[#2563eb] disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {isLoading ? "Analyzing..." : "Analyze"}
        </button>
        <button
          onClick={() => setShowExamples(!showExamples)}
          disabled={isLoading}
          className="px-4 py-3 bg-[#1e293b] text-[#94a3b8] rounded-lg text-sm hover:bg-[#2d3a50] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap border border-[#334155]"
        >
          Examples
        </button>
      </div>
    </div>
  );
}
