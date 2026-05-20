/**
 * lib/rag/extract — unit tests for the text extractor.
 *
 * Real content only — no synthetic placeholders. We exercise:
 *  - text/plain decoded as UTF-8
 *  - text/markdown decoded as-is (no rendering)
 *  - text/csv decoded as-is (preserves structure for embedding)
 *  - mimeType with charset parameter (e.g. "text/plain; charset=utf-8")
 *  - Unknown mime type rejected with UNSUPPORTED_MIME_TYPE
 *  - Empty buffer rejected with EMPTY_INPUT
 *  - Whitespace-only content rejected with EMPTY_EXTRACT
 *  - Supported mime types listing is deterministic
 *
 * PDF parsing is covered indirectly by the integration test that uploads
 * the fixture document; this unit suite stays dep-light.
 */

import { extractText, ExtractError, getSupportedMimeTypes } from "@/lib/rag/extract";

describe("extractText — text formats", () => {
  test("decodes text/plain UTF-8 buffer", async () => {
    const text = "B2B SaaS conversion rates typically range from 2% to 5%.";
    const buf = Buffer.from(text, "utf8");
    const result = await extractText(buf, "text/plain");
    expect(result.text).toBe(text);
    expect(result.pageCount).toBeUndefined();
  });

  test("decodes text/markdown preserving formatting", async () => {
    const md = "# Conversion Rate Benchmarks\n\n- B2B SaaS: 2-5%\n- E-commerce: 1-3%\n";
    const buf = Buffer.from(md, "utf8");
    const result = await extractText(buf, "text/markdown");
    expect(result.text).toBe(md);
  });

  test("decodes text/csv preserving rows", async () => {
    const csv = "industry,conversion_rate\nB2B SaaS,3.2\nE-commerce,2.1\n";
    const buf = Buffer.from(csv, "utf8");
    const result = await extractText(buf, "text/csv");
    expect(result.text).toBe(csv);
    // CSV-as-text: the embedding model sees rows verbatim.
    expect(result.text).toContain("B2B SaaS,3.2");
  });

  test("tolerates mimeType with charset parameter", async () => {
    const text = "Some report content.";
    const buf = Buffer.from(text, "utf8");
    const result = await extractText(buf, "text/plain; charset=utf-8");
    expect(result.text).toBe(text);
  });

  test("uppercases mimeType normalized to lowercase", async () => {
    const text = "Another report.";
    const buf = Buffer.from(text, "utf8");
    const result = await extractText(buf, "TEXT/PLAIN");
    expect(result.text).toBe(text);
  });
});

describe("extractText — error paths", () => {
  test("EMPTY_INPUT for zero-length buffer", async () => {
    await expect(extractText(Buffer.from(""), "text/plain")).rejects.toMatchObject({
      name: "ExtractError",
      code: "EMPTY_INPUT",
    });
  });

  test("UNSUPPORTED_MIME_TYPE for application/json", async () => {
    const buf = Buffer.from("{}", "utf8");
    await expect(extractText(buf, "application/json")).rejects.toMatchObject({
      name: "ExtractError",
      code: "UNSUPPORTED_MIME_TYPE",
    });
  });

  test("EMPTY_EXTRACT for whitespace-only text", async () => {
    const buf = Buffer.from("   \n\n  \t  ", "utf8");
    await expect(extractText(buf, "text/plain")).rejects.toMatchObject({
      name: "ExtractError",
      code: "EMPTY_EXTRACT",
    });
  });

  test("ExtractError carries a typed code property", async () => {
    try {
      await extractText(Buffer.from(""), "text/plain");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractError);
      expect((err as ExtractError).code).toBe("EMPTY_INPUT");
    }
  });
});

describe("extractText — supported mime types", () => {
  test("getSupportedMimeTypes includes text + pdf families", () => {
    const supported = getSupportedMimeTypes();
    expect(supported).toContain("text/plain");
    expect(supported).toContain("text/markdown");
    expect(supported).toContain("text/csv");
    expect(supported).toContain("application/pdf");
  });

  test("getSupportedMimeTypes is sorted (deterministic)", () => {
    const supported = getSupportedMimeTypes();
    const sorted = [...supported].sort();
    expect(supported).toEqual(sorted);
  });
});
