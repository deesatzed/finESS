"use client";

import { useMemo, useState } from "react";
import { parseCsvText, type ParsedCsv } from "@/lib/real-data/csv";
import {
  detectDateColumn,
  detectNumericColumns,
} from "@/lib/forecast/csv-time-series";
import type { ForecastHorizon } from "@/lib/forecast/types";

export interface ForecastFormSubmit {
  csv: string;
  dateColumn: string;
  targetColumn: string;
  horizon: ForecastHorizon;
}

interface ForecastInputFormProps {
  onSubmit: (input: ForecastFormSubmit) => void;
  disabled?: boolean;
  /** Optional error from the server to display under the form. */
  serverError?: string | null;
}

export function ForecastInputForm({
  onSubmit,
  disabled = false,
  serverError = null,
}: ForecastInputFormProps) {
  const [csvText, setCsvText] = useState("");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [dateColumn, setDateColumn] = useState("");
  const [targetColumn, setTargetColumn] = useState("");
  const [horizon, setHorizon] = useState<ForecastHorizon>(1);
  const [error, setError] = useState<string | null>(null);

  const numericColumns = useMemo(
    () => (parsed ? detectNumericColumns(parsed, dateColumn || null) : []),
    [parsed, dateColumn],
  );

  const preview = useMemo(() => parsed?.rows.slice(0, 3) ?? [], [parsed]);

  function parseAndAutofill(text: string) {
    const nextParsed = parseCsvText(text);
    setParsed(nextParsed);
    const detectedDate = detectDateColumn(nextParsed) ?? nextParsed.headers[0] ?? "";
    setDateColumn(detectedDate);
    const numericOpts = detectNumericColumns(nextParsed, detectedDate);
    setTargetColumn(numericOpts[0] ?? "");
    return nextParsed;
  }

  async function handleFile(file: File | null) {
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      setCsvText(text);
      parseAndAutofill(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read CSV file");
    }
  }

  function handleParse() {
    setError(null);
    try {
      parseAndAutofill(csvText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse CSV");
    }
  }

  function handleSubmit() {
    setError(null);
    if (!csvText.trim()) {
      setError("Provide CSV data first");
      return;
    }
    if (!dateColumn) {
      setError("Select a date column");
      return;
    }
    if (!targetColumn) {
      setError("Select a target column");
      return;
    }
    if (dateColumn === targetColumn) {
      setError("Date column and target column must be different");
      return;
    }
    onSubmit({ csv: csvText, dateColumn, targetColumn, horizon });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-[1fr_240px]">
        <label className="flex min-h-[140px] flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
            Time-series CSV
          </span>
          <textarea
            value={csvText}
            onChange={(event) => {
              setCsvText(event.target.value);
              setParsed(null);
            }}
            placeholder="DayDate,Total_Census\n2025-06-21,603\n2025-06-22,598"
            className="min-h-[130px] flex-1 rounded border border-[#334155] bg-[#1e293b] px-3 py-2 font-[family-name:var(--font-geist-mono)] text-xs text-[#e2e8f0] placeholder:text-[#64748b] focus:outline-none focus:ring-2 focus:ring-[#3b82f6]"
            disabled={disabled}
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
              disabled={disabled}
              className="block w-full text-xs text-[#94a3b8] file:mr-3 file:rounded file:border-0 file:bg-[#334155] file:px-3 file:py-2 file:text-xs file:font-medium file:text-[#e2e8f0] hover:file:bg-[#475569]"
            />
          </label>

          <button
            type="button"
            onClick={handleParse}
            disabled={disabled || !csvText.trim()}
            className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm font-medium text-[#cbd5e1] hover:text-white disabled:cursor-not-allowed disabled:text-[#64748b]"
          >
            Parse Columns
          </button>

          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
              Date column
            </span>
            <select
              value={dateColumn}
              onChange={(event) => setDateColumn(event.target.value)}
              disabled={disabled || !parsed}
              className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm text-[#e2e8f0] focus:outline-none focus:ring-2 focus:ring-[#3b82f6] disabled:cursor-not-allowed"
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
              Target column (numeric)
            </span>
            <select
              value={targetColumn}
              onChange={(event) => setTargetColumn(event.target.value)}
              disabled={disabled || !parsed}
              className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm text-[#e2e8f0] focus:outline-none focus:ring-2 focus:ring-[#3b82f6] disabled:cursor-not-allowed"
            >
              <option value="">Select column...</option>
              {numericColumns.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
              Horizon (steps ahead)
            </span>
            <select
              value={horizon}
              onChange={(event) => setHorizon(Number(event.target.value) as ForecastHorizon)}
              disabled={disabled}
              className="rounded border border-[#334155] bg-[#1e293b] px-3 py-2 text-sm text-[#e2e8f0] focus:outline-none focus:ring-2 focus:ring-[#3b82f6] disabled:cursor-not-allowed"
            >
              <option value={1}>1 step</option>
              <option value={2}>2 steps</option>
              <option value={3}>3 steps</option>
            </select>
          </label>
        </div>
      </div>

      {preview.length > 0 && parsed && (
        <div className="rounded border border-[#1e293b] bg-[#0a0e1a] p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-[#64748b]">
            <span>{parsed.rows.length.toLocaleString()} rows parsed</span>
            <span>{parsed.headers.length} columns</span>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-[#94a3b8]">
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
      {serverError && (
        <p className="text-sm text-red-400" role="alert">
          {serverError}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled}
          className="rounded bg-[#3b82f6] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-[#2563eb] active:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:bg-[#1e293b] disabled:text-[#64748b]"
        >
          {disabled ? "Running forecast..." : "Run Forecast"}
        </button>
      </div>
    </div>
  );
}

export default ForecastInputForm;
