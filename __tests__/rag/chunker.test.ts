/**
 * lib/rag/chunker — unit tests for the character-window chunker.
 *
 * Real text only — no synthetic patterns that mask off-by-one bugs at
 * boundary conditions. We exercise:
 *  - Empty / whitespace-only input
 *  - Input shorter than chunkSize
 *  - Input exactly equal to chunkSize
 *  - Multi-chunk with overlap
 *  - Determinism (same input -> same chunks)
 *  - Invalid options (zero / negative / overlap >= chunkSize)
 */

import { chunkText } from "@/lib/rag/chunker";

describe("chunkText — boundary cases", () => {
  test("returns empty array for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("returns empty array for whitespace-only string", () => {
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  test("returns one chunk for input shorter than chunkSize", () => {
    const chunks = chunkText("Hello world.", { chunkSize: 100, overlap: 10 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe("Hello world.");
    expect(chunks[0].chunkId).toBe("chunk-0");
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[0].endOffset).toBe("Hello world.".length);
  });

  test("returns one chunk for input exactly equal to chunkSize", () => {
    const text = "x".repeat(50);
    const chunks = chunkText(text, { chunkSize: 50, overlap: 5 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe(text);
  });
});

describe("chunkText — multi-chunk with overlap", () => {
  test("produces overlapping chunks at the expected boundaries", () => {
    // 100 chars of alphabet-cycle so we can spot boundary errors visually
    const text = Array.from({ length: 100 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join("");
    const chunks = chunkText(text, { chunkSize: 30, overlap: 10 });
    // stride = 20; chunks at offsets 0, 20, 40, 60, 80
    expect(chunks.length).toBe(5);
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[0].endOffset).toBe(30);
    expect(chunks[1].startOffset).toBe(20);
    expect(chunks[1].endOffset).toBe(50);
    expect(chunks[4].startOffset).toBe(80);
    expect(chunks[4].endOffset).toBe(100);

    // Overlap proof: the last 10 chars of chunk[i] equal the first 10
    // chars of chunk[i+1].
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].text.slice(-10)).toBe(chunks[i + 1].text.slice(0, 10));
    }
  });

  test("final chunk may be shorter than chunkSize and is not padded", () => {
    const text = "a".repeat(75);
    const chunks = chunkText(text, { chunkSize: 30, overlap: 10 });
    // stride 20: 0-30, 20-50, 40-70, 60-75 (final shorter)
    expect(chunks.length).toBe(4);
    expect(chunks[3].endOffset).toBe(75);
    expect(chunks[3].text.length).toBe(15);
  });

  test("produces deterministic, sequential chunkIds", () => {
    const text = "x".repeat(200);
    const chunks = chunkText(text, { chunkSize: 50, overlap: 10 });
    const ids = chunks.map((c) => c.chunkId);
    expect(ids).toEqual(ids.map((_, i) => `chunk-${i}`));
  });

  test("is deterministic — same input produces same chunks", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
    const a = chunkText(text, { chunkSize: 80, overlap: 20 });
    const b = chunkText(text, { chunkSize: 80, overlap: 20 });
    expect(a).toEqual(b);
  });
});

describe("chunkText — defaults", () => {
  test("uses 1500-char / 200-overlap defaults when no options passed", () => {
    const text = "abc".repeat(800); // 2400 chars
    const chunks = chunkText(text);
    // stride 1300: 0-1500, 1300-2400 => 2 chunks
    expect(chunks.length).toBe(2);
    expect(chunks[0].endOffset).toBe(1500);
    expect(chunks[1].startOffset).toBe(1300);
    expect(chunks[1].endOffset).toBe(2400);
  });
});

describe("chunkText — option validation", () => {
  test("rejects non-positive chunkSize", () => {
    expect(() => chunkText("hi", { chunkSize: 0 })).toThrow(/positive integer/);
    expect(() => chunkText("hi", { chunkSize: -5 })).toThrow(/positive integer/);
  });

  test("rejects non-integer chunkSize", () => {
    expect(() => chunkText("hi", { chunkSize: 12.5 })).toThrow();
  });

  test("rejects negative overlap", () => {
    expect(() => chunkText("hi", { chunkSize: 100, overlap: -1 })).toThrow(
      /non-negative integer/,
    );
  });

  test("rejects overlap >= chunkSize", () => {
    expect(() => chunkText("hi", { chunkSize: 50, overlap: 50 })).toThrow(
      /strictly less than/,
    );
    expect(() => chunkText("hi", { chunkSize: 50, overlap: 80 })).toThrow();
  });

  test("rejects non-string text input", () => {
    expect(() => chunkText(undefined as unknown as string)).toThrow(/must be a string/);
    expect(() => chunkText(123 as unknown as string)).toThrow(/must be a string/);
  });
});
