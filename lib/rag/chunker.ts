/**
 * Semantic Mode B3 — text chunker.
 *
 * Splits a plain-text document into overlapping character windows for
 * embedding. Character-window chunking is intentionally chosen over
 * token-aware chunking for the first cut:
 *
 *  1. No tokenizer dependency at chunk time — keeps this module a pure
 *     function with zero external deps. The embedding model (BAAI/bge-
 *     small-en-v1.5 via @xenova/transformers) does its own tokenization
 *     downstream; truncation there is safe because BGE's context window
 *     is 512 tokens and 1500 chars (~375 tokens at 4 chars/token) fits
 *     comfortably with room for the model's special tokens.
 *  2. Deterministic: the same input always produces the same chunk
 *     boundaries — important for test stability and content-addressed
 *     dedup at the upload layer.
 *  3. Cheap: O(n) over the input, no model load.
 *
 * Chunk size and overlap are tuned for retrieval recall (smaller chunks
 * surface more granular passages) vs context preservation (larger chunks
 * keep more surrounding text for the LLM to reason over). 1500 chars /
 * 200 chars overlap is the BGE-blog-recommended starting point for
 * mixed prose; tune later if recall is poor on real corpora.
 *
 * Boundary behavior:
 *  - Empty / whitespace-only input returns an empty array.
 *  - Input shorter than `chunkSize` returns one chunk containing the
 *    entire (trimmed) input.
 *  - Overlap windows preserve the trailing `overlap` chars of each chunk
 *    at the start of the next so context spanning a boundary is not lost.
 *  - The final chunk is whatever remains; it may be shorter than
 *    `chunkSize` but is never padded.
 *
 * No mock or synthetic data here — this is a pure string-handling
 * function that operates on whatever real text the extract layer hands
 * it.
 */

export interface Chunk {
  /** Stable id within the document — sequential 0-based index. */
  chunkId: string;
  /** The raw text content of this chunk (trimmed at chunk edges, NOT at internal whitespace). */
  text: string;
  /** Inclusive character offset where this chunk begins in the source. */
  startOffset: number;
  /** Exclusive character offset where this chunk ends in the source. */
  endOffset: number;
}

export interface ChunkOptions {
  /** Maximum characters per chunk. Default 1500. */
  chunkSize?: number;
  /** Characters of overlap between adjacent chunks. Default 200. */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

/**
 * Split `text` into overlapping character-window chunks.
 *
 * Throws if `overlap >= chunkSize` (would loop forever) or if either
 * value is non-positive.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(
      `chunkText: chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error(
      `chunkText: overlap must be a non-negative integer, got ${overlap}`,
    );
  }
  if (overlap >= chunkSize) {
    throw new Error(
      `chunkText: overlap (${overlap}) must be strictly less than chunkSize (${chunkSize})`,
    );
  }

  if (typeof text !== "string") {
    throw new Error(
      `chunkText: text must be a string, got ${typeof text}`,
    );
  }

  // Trim only the entire source (leading/trailing whitespace) — internal
  // whitespace is preserved so chunk boundaries line up with the original
  // offsets. An entirely-whitespace input returns no chunks.
  const trimmed = text.trim();
  if (trimmed === "") return [];

  // Adjust offsets to account for the leading whitespace we trimmed so
  // startOffset/endOffset refer to positions in the trimmed source.
  const chunks: Chunk[] = [];
  const stride = chunkSize - overlap; // strictly positive due to checks above

  let index = 0;
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + chunkSize, trimmed.length);
    const slice = trimmed.slice(start, end);
    chunks.push({
      chunkId: `chunk-${index}`,
      text: slice,
      startOffset: start,
      endOffset: end,
    });
    index += 1;
    if (end >= trimmed.length) break;
    start += stride;
  }

  return chunks;
}
