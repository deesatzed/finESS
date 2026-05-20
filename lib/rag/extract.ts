/**
 * Semantic Mode B3 — text extractor for uploaded reference documents.
 *
 * Routes incoming `Buffer` + `mimeType` to the right plain-text
 * extractor. Supported types (per the B3 spec): plain text, markdown,
 * CSV, and PDF.
 *
 * Design decisions:
 *  1. Single entry point `extractText(buffer, mimeType, filename)` so
 *     the upload route doesn't have to switch on mime — it just hands us
 *     bytes and trusts us to recover real, human-readable text.
 *  2. For text-like formats (text/plain, text/markdown, text/csv) we
 *     decode UTF-8 directly. No transformation of CSV into prose — the
 *     embedding model handles structured text well enough that the
 *     embedding signal carries the column-row relationships. Future:
 *     could synthesize "row N: col=val, col=val" prose per row if recall
 *     on CSVs proves poor.
 *  3. PDF extraction uses `pdf-parse` v2 (PDFParse class + getText()).
 *     pdf-parse is a wrapper around pdf.js, runs in Node without a
 *     headless browser, and emits TextResult.text. We deliberately do
 *     NOT extract images, tables, or PDF metadata here — only the text
 *     stream feeds embedding.
 *  4. Unknown mimeType raises ExtractError("UNSUPPORTED_MIME_TYPE") so
 *     the API layer can return a clean 400 with the supported list.
 *  5. Empty extracted text (whitespace only) raises EMPTY_EXTRACT so the
 *     upload layer can reject scans / image-only PDFs at the boundary
 *     rather than silently storing a zero-chunk row.
 *
 * Loader strategy: pdf-parse transitively requires pdfjs-dist and
 * canvas (native). To keep webpack out of the dependency graph we
 * resolve pdf-parse at runtime via a string the bundler cannot analyze.
 * Same pattern as lib/rag/embed.ts and lib/rag/store.ts.
 *
 * Hard errors are thrown as typed `ExtractError`; the API route uses the
 * `.code` to choose the right HTTP status.
 */

export type ExtractErrorCode =
  | "EMPTY_INPUT"
  | "UNSUPPORTED_MIME_TYPE"
  | "EMPTY_EXTRACT"
  | "EXTRACT_FAILED";

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;
  constructor(message: string, code: ExtractErrorCode) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
  }
}

export interface ExtractResult {
  text: string;
  /** Best-effort page count for PDFs; undefined for text formats. */
  pageCount?: number;
}

const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
]);

const PDF_MIME_TYPE = "application/pdf";

/**
 * Normalize a mimeType: lowercase, strip parameters (e.g. "; charset=utf-8").
 */
function normalizeMimeType(raw: string): string {
  return raw
    .toLowerCase()
    .split(";")[0]
    .trim();
}

/**
 * The full set of supported mime types. Exposed so the API layer can
 * surface the allowed list in its 400 error message.
 */
export function getSupportedMimeTypes(): string[] {
  return [...TEXT_MIME_TYPES, PDF_MIME_TYPE].sort();
}

/**
 * Decode `buffer` to a string assuming UTF-8. Replacement characters
 * are tolerated — corrupt bytes degrade gracefully instead of throwing.
 */
function decodeUtf8(buffer: Buffer): string {
  return buffer.toString("utf8");
}

interface PdfParseModule {
  PDFParse: new (opts: { data: Uint8Array }) => {
    getText: () => Promise<{ text?: string; total?: number }>;
    destroy: () => Promise<void>;
  };
}

/**
 * Runtime-resolve `pdf-parse` via a string webpack cannot analyze.
 * Keeps pdfjs-dist + canvas (transitive deps) out of the bundle.
 */
function loadPdfParseModule(): PdfParseModule {
  const pkg = ["pdf", "parse"].join("-");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
  const dynamicRequire = eval("require") as NodeRequire;
  return dynamicRequire(pkg) as PdfParseModule;
}

async function extractPdf(buffer: Buffer): Promise<ExtractResult> {
  let pdfParseModule: PdfParseModule;
  try {
    pdfParseModule = loadPdfParseModule();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractError(
      `pdf-parse module failed to load: ${message}`,
      "EXTRACT_FAILED",
    );
  }
  const PDFParse = pdfParseModule.PDFParse;
  if (!PDFParse) {
    throw new ExtractError(
      "pdf-parse module did not export PDFParse class",
      "EXTRACT_FAILED",
    );
  }

  // pdf-parse expects Uint8Array; Buffer is a subclass so this is safe,
  // but we convert defensively to a plain Uint8Array view.
  const data = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  let parser: InstanceType<typeof PDFParse>;
  try {
    parser = new PDFParse({ data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractError(`PDF parser init failed: ${message}`, "EXTRACT_FAILED");
  }

  try {
    const result = await parser.getText();
    const text = typeof result.text === "string" ? result.text : "";
    return { text, pageCount: result.total };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractError(`PDF text extraction failed: ${message}`, "EXTRACT_FAILED");
  } finally {
    try {
      await parser.destroy();
    } catch {
      // Best-effort cleanup; suppress to avoid masking the real error.
    }
  }
}

/**
 * Extract plain text from `buffer` according to `mimeType`. Returns the
 * extracted text and (for PDFs) a page count.
 *
 * Throws `ExtractError` with a typed `.code` on failure:
 *  - `EMPTY_INPUT`: buffer is null / zero length
 *  - `UNSUPPORTED_MIME_TYPE`: the type is not in `getSupportedMimeTypes()`
 *  - `EMPTY_EXTRACT`: extraction succeeded but produced no usable text
 *  - `EXTRACT_FAILED`: the underlying parser raised
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  // Filename is accepted for future heuristics (mime sniffing on
  // application/octet-stream uploads, audit logging) but currently
  // unused by the extractor body.
  filename?: string,
): Promise<ExtractResult> {
  void filename;
  if (!buffer || buffer.length === 0) {
    throw new ExtractError("extractText: buffer is empty", "EMPTY_INPUT");
  }

  const type = normalizeMimeType(mimeType);

  let result: ExtractResult;
  if (TEXT_MIME_TYPES.has(type)) {
    result = { text: decodeUtf8(buffer) };
  } else if (type === PDF_MIME_TYPE) {
    result = await extractPdf(buffer);
  } else {
    throw new ExtractError(
      `Unsupported mimeType "${mimeType}". Supported: ${getSupportedMimeTypes().join(", ")}`,
      "UNSUPPORTED_MIME_TYPE",
    );
  }

  if (result.text.trim() === "") {
    throw new ExtractError(
      "Extraction produced no usable text (document may be empty, image-only, or scanned)",
      "EMPTY_EXTRACT",
    );
  }

  return result;
}
