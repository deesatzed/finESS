/**
 * Time-series-specific validation helpers built on top of
 * `lib/real-data/csv.ts`.
 *
 * The sidecar (services/ensemble) only accepts rows where:
 *   - the date column parses as a real date in every row, and
 *   - the chosen target column is finite numeric in every non-blank row.
 *
 * Pushing those checks into the API layer (instead of waiting for a 400 to
 * come back from Python) gives users a precise error pointing at the row
 * that failed, and lets the UI block the "Run Forecast" button before any
 * network round trip.
 */

import { parseCsvText, type ParsedCsv } from "@/lib/real-data/csv";

export class TimeSeriesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeSeriesValidationError";
  }
}

export interface ValidatedTimeSeries {
  parsed: ParsedCsv;
  /** Rows already coerced: date cells -> ISO date strings, target -> number. */
  rows: Array<Record<string, string | number>>;
  rowCount: number;
}

/** Heuristic: which header looks the most date-like in the sample data? */
export function detectDateColumn(parsed: ParsedCsv): string | null {
  const sample = parsed.rows.slice(0, 25);
  for (const header of parsed.headers) {
    const successes = sample.reduce((count, row) => {
      const cell = row[header];
      return cell && isParseableDate(cell) ? count + 1 : count;
    }, 0);
    if (sample.length > 0 && successes / sample.length >= 0.9) {
      return header;
    }
  }
  return null;
}

/** Heuristic: first header whose sample values are all numeric. */
export function detectNumericColumns(parsed: ParsedCsv, excludeHeader: string | null): string[] {
  const sample = parsed.rows.slice(0, 25);
  return parsed.headers.filter((header) => {
    if (header === excludeHeader) return false;
    const numericCount = sample.reduce((count, row) => {
      const cell = row[header];
      if (cell === undefined || cell === "") return count;
      return Number.isFinite(Number(cell)) ? count + 1 : count;
    }, 0);
    const nonEmpty = sample.filter((row) => {
      const cell = row[header];
      return cell !== undefined && cell !== "";
    }).length;
    return nonEmpty > 0 && numericCount === nonEmpty;
  });
}

function isParseableDate(value: string): boolean {
  if (!value) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

const MIN_ROWS_FOR_FORECAST = 30;

/**
 * Parse + validate a CSV for use with the ensemble sidecar.
 *
 * Throws TimeSeriesValidationError on the first row that fails so the
 * client surface can highlight the offending row number.
 */
export function validateTimeSeriesCsv(
  csvText: string,
  dateColumn: string,
  targetColumn: string,
): ValidatedTimeSeries {
  const parsed = parseCsvText(csvText);
  if (!parsed.headers.includes(dateColumn)) {
    throw new TimeSeriesValidationError(
      `Date column '${dateColumn}' not present in CSV headers`,
    );
  }
  if (!parsed.headers.includes(targetColumn)) {
    throw new TimeSeriesValidationError(
      `Target column '${targetColumn}' not present in CSV headers`,
    );
  }
  if (dateColumn === targetColumn) {
    throw new TimeSeriesValidationError(
      "Date column and target column must be different",
    );
  }
  if (parsed.rows.length < MIN_ROWS_FOR_FORECAST) {
    throw new TimeSeriesValidationError(
      `Forecast Mode needs at least ${MIN_ROWS_FOR_FORECAST} rows; got ${parsed.rows.length}`,
    );
  }

  const rows: Array<Record<string, string | number>> = parsed.rows.map((row, index) => {
    const lineNo = index + 2; // header is line 1
    const out: Record<string, string | number> = { ...row };

    const dateCell = row[dateColumn];
    if (!dateCell || !isParseableDate(dateCell)) {
      throw new TimeSeriesValidationError(
        `Row ${lineNo}: date column '${dateColumn}' value '${dateCell}' is not a parseable date`,
      );
    }
    const isoDate = new Date(dateCell).toISOString().slice(0, 10);
    out[dateColumn] = isoDate;

    const targetCell = row[targetColumn];
    if (targetCell === undefined || targetCell === "") {
      throw new TimeSeriesValidationError(
        `Row ${lineNo}: target column '${targetColumn}' is empty`,
      );
    }
    const targetNum = Number(targetCell);
    if (!Number.isFinite(targetNum)) {
      throw new TimeSeriesValidationError(
        `Row ${lineNo}: target column '${targetColumn}' value '${targetCell}' is not numeric`,
      );
    }
    out[targetColumn] = targetNum;

    // Best-effort: coerce any other obviously-numeric cells so the sidecar
    // gets numbers, not strings, on every column it might engineer features from.
    for (const header of parsed.headers) {
      if (header === dateColumn || header === targetColumn) continue;
      const cell = row[header];
      if (cell !== undefined && cell !== "") {
        const asNum = Number(cell);
        if (Number.isFinite(asNum) && cell.trim() !== "") {
          out[header] = asNum;
        }
      }
    }

    return out;
  });

  return { parsed, rows, rowCount: rows.length };
}
