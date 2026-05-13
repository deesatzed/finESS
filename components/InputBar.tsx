"use client";

import { useState, useRef } from "react";

interface InputBarProps {
  onSubmit: (query: string) => void;
  isLoading: boolean;
  onRunExample: () => void;
}

export function InputBar({ onSubmit, isLoading, onRunExample }: InputBarProps) {
  const [query, setQuery] = useState("");
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

  return (
    <div className="w-full px-4 py-3 bg-[#0f1629] border-t border-[#1e293b]">
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
          onClick={onRunExample}
          disabled={isLoading}
          className="px-4 py-3 bg-[#1e293b] text-[#94a3b8] rounded-lg text-sm hover:bg-[#2d3a50] hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap border border-[#334155]"
        >
          PE Demo
        </button>
      </div>
    </div>
  );
}
