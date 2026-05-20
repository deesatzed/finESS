/**
 * Semantic Mode B3 — local embedding via @xenova/transformers.
 *
 * Lazy-loads the BAAI/bge-small-en-v1.5 feature-extraction pipeline
 * (384-dim, mean-pool + L2-normalize per the BGE recipe) and exposes a
 * batch `embed(texts) -> number[][]` function.
 *
 * Why this is the right adapter:
 *  - The workspace CLAUDE.md pins the embedding model to BAAI/bge-small-
 *    en-v1.5 (384 dims). Xenova publishes a quantized ONNX port of that
 *    exact model under `Xenova/bge-small-en-v1.5` that runs in pure
 *    Node via @xenova/transformers — no Python sidecar, no native
 *    dependencies, no API key.
 *  - First-use download is ~130 MB into `data/.cache/transformers`
 *    (gitignored; see `.gitignore`). Subsequent calls hit the cache and
 *    boot in seconds. This cost is documented in `.env.example` and the
 *    function's JSDoc so production deploys know the disk footprint.
 *  - We hold the pipeline handle in a module-level singleton because
 *    each `pipeline()` call re-loads the model weights (multi-second
 *    cold start). All callers share one handle.
 *
 * Loader strategy: webpack (Next.js build) would otherwise try to bundle
 * `@xenova/transformers` AND its transitive native ONNX binaries — but
 * those `.node` files are not webpack-loadable. We therefore load the
 * module via a runtime indirection (`loadModule()`) that uses a string
 * concatenation webpack cannot statically analyze. This:
 *   1. Keeps the route bundle small (xenova never goes into the client
 *      OR server webpack output).
 *   2. Keeps Jest (CommonJS) happy because the ESM-only module is
 *      `require()`d at runtime, not parsed at test boot.
 *   3. Mirrors the documented "external native dep" pattern used by
 *      sharp / onnxruntime users in Next.js.
 *
 * Dep weight justification (per workspace no-mock + minimum-deps rules):
 *  - @xenova/transformers is local-only; embeddings never leave the
 *    machine. This satisfies the "local-only / single-user posture" rule
 *    from CLAUDE.md and the realignment plan (B3 docs explicitly require
 *    documents stay on the local machine).
 *  - Alternative — hosted OpenAI / Voyage embeddings — would (a) leak
 *    user-uploaded reference docs to a third party, (b) add a cost
 *    vector, (c) require an API key. None of those are acceptable for
 *    B3 per the realignment doc.
 *
 * Mean-pool + L2-normalize is the canonical BGE configuration; cosine
 * similarity over L2-normalized vectors becomes a dot product, which is
 * what LanceDB's vector index uses by default.
 */

import path from "node:path";

/** BGE small English v1.5; 384 dims. Caller can override for tests only. */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

/** Dimensionality of the default model. Used by the LanceDB schema. */
export const DEFAULT_EMBEDDING_DIM = 384;

/**
 * Local on-disk cache for downloaded model weights. Lives under
 * `<repo>/data/.cache/transformers` (gitignored).
 */
function defaultCacheDir(): string {
  return path.join(process.cwd(), "data", ".cache", "transformers");
}

// Typed as a callable so we don't import xenova types at module load.
type EmbedderHandle = (
  input: string,
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; size?: number }>;

interface EmbedderState {
  handle: EmbedderHandle | null;
  loadingPromise: Promise<EmbedderHandle> | null;
  modelId: string;
}

const state: EmbedderState = {
  handle: null,
  loadingPromise: null,
  modelId: DEFAULT_EMBEDDING_MODEL,
};

interface XenovaModule {
  pipeline: (
    task: string,
    modelId: string,
  ) => Promise<EmbedderHandle>;
  env?: { cacheDir?: string };
}

/**
 * Runtime-resolve `@xenova/transformers` via a path webpack cannot
 * statically analyze. The string concatenation defeats webpack's
 * static-import detection, keeping the heavy ONNX binaries out of the
 * build output. Node's runtime `require` still resolves the module
 * normally from `node_modules`.
 *
 * We use `eval('require')` (not bare `require`) so this also works
 * inside Next.js server bundles where `require` may be shimmed.
 */
async function loadXenovaModule(): Promise<XenovaModule> {
  // Build the module specifier at runtime — `["@", "xenova", ...]` is
  // opaque to webpack's parser.
  const pkg = ["@xenova", "transformers"].join("/");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
  const dynamicRequire = eval("require") as NodeRequire;
  return dynamicRequire(pkg) as XenovaModule;
}

/**
 * Lazy-init the feature-extraction pipeline. Concurrent callers share
 * the same in-flight load promise so we never double-load weights.
 */
async function getEmbedder(modelId: string): Promise<EmbedderHandle> {
  if (state.handle && state.modelId === modelId) return state.handle;
  if (state.loadingPromise && state.modelId === modelId) {
    return state.loadingPromise;
  }

  state.modelId = modelId;

  const mod = await loadXenovaModule();

  // Configure xenova's cache dir before first load. Best-effort.
  try {
    if (mod.env && typeof mod.env === "object") {
      mod.env.cacheDir = defaultCacheDir();
    }
  } catch {
    // Suppress — cacheDir tuning is best-effort.
  }

  state.loadingPromise = mod
    .pipeline("feature-extraction", modelId)
    .then(
      (handle) => {
        state.handle = handle;
        state.loadingPromise = null;
        return handle;
      },
      (err) => {
        state.loadingPromise = null;
        throw err;
      },
    );
  return state.loadingPromise;
}

export interface EmbedOptions {
  /** Override the model id (test-only). Production callers omit. */
  modelId?: string;
}

export class EmbedError extends Error {
  readonly code: "EMPTY_INPUT" | "MODEL_LOAD_FAILED" | "INFERENCE_FAILED";
  constructor(
    message: string,
    code: "EMPTY_INPUT" | "MODEL_LOAD_FAILED" | "INFERENCE_FAILED",
  ) {
    super(message);
    this.name = "EmbedError";
    this.code = code;
  }
}

/**
 * Embed a list of texts into 384-dim L2-normalized float vectors.
 *
 * The pipeline is invoked per-text (not as a single batched call)
 * because @xenova/transformers's batched outputs require fiddly tensor
 * reshaping and the per-text loop is plenty fast for the document-
 * indexing use case (one-off at upload time; per-query at retrieval
 * time is a single text).
 *
 * Returns: `number[][]` with shape `[texts.length, 384]`. Each row is
 * mean-pooled across tokens and L2-normalized so cosine similarity ==
 * dot product.
 */
export async function embed(
  texts: string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new EmbedError("embed: texts must be a non-empty array", "EMPTY_INPUT");
  }
  for (let i = 0; i < texts.length; i++) {
    if (typeof texts[i] !== "string" || texts[i].trim() === "") {
      throw new EmbedError(
        `embed: texts[${i}] must be a non-empty string`,
        "EMPTY_INPUT",
      );
    }
  }

  const modelId = options.modelId ?? DEFAULT_EMBEDDING_MODEL;
  let embedder: EmbedderHandle;
  try {
    embedder = await getEmbedder(modelId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EmbedError(
      `Failed to load embedding model "${modelId}": ${message}`,
      "MODEL_LOAD_FAILED",
    );
  }

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    try {
      const tensor = await embedder(texts[i], {
        pooling: "mean",
        normalize: true,
      });

      // The tensor's `data` is a typed array of length `size` (or
      // 384 by default). Convert to a plain number[] for downstream
      // serialization (LanceDB accepts both, but plain arrays are
      // friendlier for Jest snapshots and JSON-fallback paths).
      const raw = tensor.data;
      const vec: number[] =
        raw instanceof Float32Array ? Array.from(raw) : Array.from(raw);
      out.push(vec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new EmbedError(
        `Embedding inference failed at texts[${i}]: ${message}`,
        "INFERENCE_FAILED",
      );
    }
  }
  return out;
}

/**
 * Test-only helper: reset the cached pipeline so unit tests can
 * exercise the lazy-load path without state leaking between cases.
 */
export function __resetEmbedderForTests(): void {
  state.handle = null;
  state.loadingPromise = null;
  state.modelId = DEFAULT_EMBEDDING_MODEL;
}
