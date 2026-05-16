"use client";

import { useMemo, useState } from "react";
import { analyzeObservedRows, type ObservedAnalysisResult } from "@/lib/real-data/analyze";
import { parseCsvText, type ParsedCsv } from "@/lib/real-data/csv";

interface RealDataPanelProps {
  onAnalyze: (analysis: ObservedAnalysisResult) => void;
  onRunLegacyDemo: () => void;
}

export function RealDataPanel({
  onAnalyze,
  onRunLegacyDemo,
}: RealDataPanelProps) {
  const [csvText, setCsvText] = useState("");
  const [targetColumn, setTargetColumn] = useState("");
  const [thresholdText, setThresholdText] = useState("");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewRows = useMemo(() => parsed?.rows.slice(0, 3) ?? [], [parsed]);
  const sampleCsv = "id,outcome,score\n1,yes,0.82\n2,no,0.18\n3,yes,0.74\n4,yes,0.91\n5,,0.44";

  const parseCurrentCsv = (text = csvText) => {
    const nextParsed = parseCsvText(text);
    setParsed(nextParsed);
    if (!nextParsed.headers.includes(targetColumn)) {
      setTargetColumn(nextParsed.headers[nextParsed.headers.length - 1] ?? "");
    }
    return nextParsed;
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      setCsvText(text);
      parseCurrentCsv(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read CSV file");
    }
  };

  const handleAnalyze = () => {
    setError(null);
    try {
      const currentParsed = parsed ?? parseCurrentCsv();
      const threshold =
        thresholdText.trim() === "" ? null : Number(thresholdText.trim());
      if (threshold !== null && !Number.isFinite(threshold)) {
        throw new Error("Threshold must be numeric");
      }
      onAnalyze(analyzeObservedRows(currentParsed.rows, targetColumn, threshold));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze CSV");
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-[0.18em] text-[#64748b]">
            Real Data Mode
          </p>
          <h2 className="text-2xl font-semibold text-white">
            Analyze observed records
          </h2>
          <p className="text-sm leading-5 text-[#94a3b8]">
            Paste or upload a local CSV, select the measured outcome column, and
            compute empirical results from those rows.
          </p>
          <p className="text-xs text-[#64748b]">
            CSV stays local for empirical calculation. AI Assist sends only summary
            statistics after you click it.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_220px]">
          <label className="flex min-h-[130px] flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
              CSV data
            </span>
            <textarea
              value={csvText}
              onChange={(event) => {
                setCsvText(event.target.value);
                setParsed(null);
              }}
              placeholder={"id,outcome\n1,yes\n2,no"}
              className="min-h-[120px] flex-1 rounded border border-[#334155] bg-[#1e293b] px-3 py-2 font-[family-name:var(--font-geist-mono)] text-xs text-[#e2e8f0] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#3b82f6]"
            />
          </label>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
                Upload CSV
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
                className="block w-full text-xs text-[#94a3b8] file:mr-3 file:rounded file:border-0 file:bg-[#334155] file:px-3 file:py-2 file:text-xs file:font-medium file:text-[#e2e8f0] hover:file:bg-[#475569]"
              />
            </label>

            <button
              type="button"
              onClick={() => {
                setError(null);
                setCsvText(sampleCsv);
                const nextParsed = parseCsvText(sampleCsv);
                setParsed(nextParsed);
                setTargetColumn("outcome");
                setThresholdText("");
              }}
              className="rounded border border-[#334155] bg-[#111827] px-3 py-2 text-sm font-medium text-[#cbd5e1] hover:text-white"
            >
              Use Sample CSV
            </button>

            <button
              type="button"
              onClick={() => {
                setError(null);
                try {
                  parseCurrentCsv();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not parse CSV");
                }
              }}
              className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm font-medium text-[#cbd5e1] hover:text-white"
            >
              Parse Columns
            </button>

            <label className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
                Target column
              </span>
              <select
                value={targetColumn}
                onChange={(event) => setTargetColumn(event.target.value)}
                className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm text-[#e2e8f0] focus:outline-none focus:ring-2 focus:ring-[#3b82f6]"
              >
                <option value="">Select column...</option>
                {parsed?.headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
                Threshold
              </span>
              <input
                value={thresholdText}
                onChange={(event) => setThresholdText(event.target.value)}
                placeholder="optional"
                className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm text-[#e2e8f0] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#3b82f6]"
              />
            </label>
          </div>
        </div>

        {previewRows.length > 0 && (
          <div className="rounded border border-[#1e293b] bg-[#0a0e1a] p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-[#64748b]">
              <span>{parsed?.rows.length.toLocaleString()} rows parsed</span>
              <span>{parsed?.headers.join(" / ")}</span>
            </div>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-[#94a3b8]">
              {JSON.stringify(previewRows, null, 2)}
            </pre>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-center">
          <button
            type="button"
            onClick={handleAnalyze}
            className="rounded bg-[#3b82f6] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8]"
          >
            Analyze Observed Data
          </button>
          <button
            type="button"
            onClick={onRunLegacyDemo}
            className="rounded border border-[#334155] bg-[#1e293b] px-5 py-3 text-sm font-medium text-[#cbd5e1] transition-colors hover:bg-[#2d3a50] hover:text-white"
          >
            Legacy PE simulation demo
          </button>
        </div>
      </div>
    </div>
  );
}
