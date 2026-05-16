export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

const MAX_ROWS = 5_000;
const MAX_CELL_LENGTH = 20_000;

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

export function parseCsvText(text: string): ParsedCsv {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CsvParseError("CSV input is empty");
  }

  const records = parseRecords(trimmed);
  if (records.length < 2) {
    throw new CsvParseError("CSV must include a header row and at least one data row");
  }

  const headers = records[0].map((header) => header.trim());
  if (headers.some((header) => header === "")) {
    throw new CsvParseError("CSV headers must be non-empty");
  }
  if (new Set(headers).size !== headers.length) {
    throw new CsvParseError("CSV headers must be unique");
  }

  const rows = records.slice(1, MAX_ROWS + 1).map((record, rowIndex) => {
    if (record.length !== headers.length) {
      throw new CsvParseError(
        `Row ${rowIndex + 2} has ${record.length} columns; expected ${headers.length}`
      );
    }

    return Object.fromEntries(
      headers.map((header, index) => {
        const value = record[index].trim();
        if (value.length > MAX_CELL_LENGTH) {
          throw new CsvParseError(`Row ${rowIndex + 2} contains an oversized cell`);
        }
        return [header, value];
      })
    );
  });

  if (rows.length === 0) {
    throw new CsvParseError("CSV must include at least one data row");
  }

  return { headers, rows };
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      record.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      record.push(cell);
      if (record.some((value) => value.trim() !== "")) records.push(record);
      record = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (inQuotes) {
    throw new CsvParseError("CSV contains an unclosed quoted value");
  }

  record.push(cell);
  if (record.some((value) => value.trim() !== "")) records.push(record);
  return records;
}
