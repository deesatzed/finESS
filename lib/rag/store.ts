/**
 * Semantic Mode B3 — LanceDB vector store wrapper.
 *
 * One LanceDB table per workspace. Each row stores:
 *
 *   - documentId: string  (links back to SemanticDocument.id in Prisma)
 *   - chunkId:    string  (sequential id within the document; see chunker.ts)
 *   - text:       string  (the raw chunk text — needed for citation display
 *                         so the LLM can quote the source)
 *   - sourceFilename: string  (denormalized copy of SemanticDocument.filename
 *                              so retrieval results carry it without a join)
 *   - vector:     Float32Array (DEFAULT_EMBEDDING_DIM = 384 floats; L2-norm'd)
 *
 * Storage layout on disk:
 *
 *   <repo>/data/lancedb/
 *     <workspaceId>/                  (one LanceDB database per workspace)
 *       workspace_<workspaceId>/      (one Lance table per workspace —
 *                                     name kept stable so reopens hit cache)
 *
 * Why per-workspace databases (not a single global table with a
 * workspaceId filter):
 *  1. Cross-workspace isolation is enforced at the filesystem level.
 *     A bug in the query path can leak rows within a workspace but
 *     never across workspaces.
 *  2. Deleting a workspace = `rm -rf data/lancedb/<workspaceId>`. No
 *     orphaned rows.
 *  3. Index pruning per workspace stays cheap.
 *
 * Why we keep `text` in the table even though it duplicates the source
 * document: the orchestrator needs the chunk text to feed back into the
 * LLM as the supporting passage AND to surface in the UI as a citation
 * excerpt. The original document bytes are deliberately NOT persisted
 * (privacy + storage; see SemanticDocument schema doc).
 *
 * Loader strategy: @lancedb/lancedb is a Rust-native package with
 * platform-specific `.node` binaries that webpack cannot bundle. We
 * therefore resolve the module via a runtime indirection that defeats
 * webpack's static-import analysis. Same pattern as lib/rag/embed.ts.
 *
 * No mock, no demo: every chunk written here comes from a real
 * extract+embed pass against a real user upload.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULT_EMBEDDING_DIM } from "@/lib/rag/embed";

// Minimal structural typings for the bits of @lancedb/lancedb we use.
// We deliberately do NOT import the package's d.ts at top level — that
// would force webpack to resolve the native binaries during the
// Next.js build. The runtime cast inside `loadLanceModule()` is the
// only place we touch the real module.
interface LanceTable {
  add: (rows: Record<string, unknown>[]) => Promise<unknown>;
  delete: (predicate: string) => Promise<unknown>;
  countRows: () => Promise<number>;
  search: (vec: number[]) => {
    limit: (n: number) => { toArray: () => Promise<Record<string, unknown>[]> };
  };
}

interface LanceConnection {
  tableNames: () => Promise<string[]>;
  createTable: (
    name: string,
    data: Record<string, unknown>[],
  ) => Promise<LanceTable>;
  openTable: (name: string) => Promise<LanceTable>;
}

interface LanceModule {
  connect: (uri: string) => Promise<LanceConnection>;
}

/** Row stored in LanceDB per chunk. */
export interface StoredChunk {
  documentId: string;
  chunkId: string;
  text: string;
  sourceFilename: string;
  vector: number[];
}

/** Result returned by a `query()` call. Vector is omitted for size. */
export interface QueryHit {
  documentId: string;
  chunkId: string;
  text: string;
  sourceFilename: string;
  /** Distance metric from LanceDB. Lower = closer (L2). */
  distance: number;
}

const DEFAULT_ROOT_DIR_ENV = "FINESS_LANCEDB_ROOT";

/**
 * Root directory where per-workspace LanceDB databases live.
 * Overridable via `FINESS_LANCEDB_ROOT` env var for tests; defaults to
 * `<repo>/data/lancedb` (gitignored).
 */
export function resolveLanceRootDir(): string {
  const override = process.env[DEFAULT_ROOT_DIR_ENV];
  if (override && override.trim() !== "") return override;
  return path.join(process.cwd(), "data", "lancedb");
}

function workspaceDbDir(workspaceId: string): string {
  if (!workspaceId || workspaceId.trim() === "") {
    throw new Error("LanceDB store: workspaceId must be a non-empty string");
  }
  // sanitize: workspace ids are cuids (alphanumeric); reject anything else
  // to keep paths from escaping the root.
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new Error(
      `LanceDB store: workspaceId "${workspaceId}" contains unsafe characters`,
    );
  }
  return path.join(resolveLanceRootDir(), workspaceId);
}

function tableName(workspaceId: string): string {
  return `workspace_${workspaceId}`;
}

/**
 * Runtime-load the LanceDB module via a path string webpack cannot
 * statically resolve. See lib/rag/embed.ts for the rationale.
 */
function loadLanceModule(): LanceModule {
  const pkg = ["@lancedb", "lancedb"].join("/");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
  const dynamicRequire = eval("require") as NodeRequire;
  return dynamicRequire(pkg) as LanceModule;
}

/**
 * Open or create the LanceDB connection for a workspace.
 * The directory is created on demand.
 */
async function openConnection(
  workspaceId: string,
): Promise<LanceConnection> {
  const dir = workspaceDbDir(workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const mod = loadLanceModule();
  return mod.connect(dir);
}

/**
 * Ensure the workspace's vector table exists with the expected schema.
 * Returns the open Table.
 *
 * We avoid pre-declaring an explicit Arrow schema because @lancedb/lancedb
 * infers it from the first batch of data we insert. To handle the empty
 * case (creating the table before any rows are added), we seed with a
 * deterministic zero-vector row and immediately delete it — this fixes
 * the schema without leaving sentinel data.
 */
async function openOrCreateTable(
  workspaceId: string,
): Promise<LanceTable> {
  const conn = await openConnection(workspaceId);
  const name = tableName(workspaceId);
  const names = await conn.tableNames();
  if (names.includes(name)) {
    return conn.openTable(name);
  }

  // Seed row so LanceDB has a row to infer schema from. We then delete
  // it so the user never sees this sentinel. Using a per-workspace seed
  // documentId so we can DELETE WHERE precisely.
  const seedVector = new Array(DEFAULT_EMBEDDING_DIM).fill(0);
  const seed = [
    {
      documentId: "__schema_seed__",
      chunkId: "__seed__",
      text: "",
      sourceFilename: "",
      vector: seedVector,
    },
  ];
  const table = await conn.createTable(name, seed);
  await table.delete(`documentId = '__schema_seed__'`);
  return table;
}

/**
 * Append `chunks` to the workspace's table. No de-dup is done here;
 * the API layer enforces content-addressed dedup via SemanticDocument's
 * unique (userId, sha256) index BEFORE calling this.
 */
export async function addChunks(
  workspaceId: string,
  documentId: string,
  sourceFilename: string,
  chunks: Array<{ chunkId: string; text: string; vector: number[] }>,
): Promise<{ added: number }> {
  if (chunks.length === 0) return { added: 0 };

  const table = await openOrCreateTable(workspaceId);

  // Validate vector shape up front — a wrong-dim vector silently
  // poisons the index. Fail loud.
  for (let i = 0; i < chunks.length; i++) {
    const v = chunks[i].vector;
    if (!Array.isArray(v) || v.length !== DEFAULT_EMBEDDING_DIM) {
      throw new Error(
        `addChunks: chunk[${i}] vector dimension ${v?.length} != expected ${DEFAULT_EMBEDDING_DIM}`,
      );
    }
  }

  const rows = chunks.map((c) => ({
    documentId,
    chunkId: c.chunkId,
    text: c.text,
    sourceFilename,
    vector: c.vector,
  }));

  await table.add(rows);
  return { added: rows.length };
}

/**
 * Find the top-K nearest chunks to `embedding` in the workspace's table.
 *
 * If the table does not yet exist for this workspace (no documents
 * uploaded), returns an empty array.
 */
export async function query(
  workspaceId: string,
  embedding: number[],
  k = 5,
): Promise<QueryHit[]> {
  if (!Array.isArray(embedding) || embedding.length !== DEFAULT_EMBEDDING_DIM) {
    throw new Error(
      `query: embedding dimension ${embedding?.length} != expected ${DEFAULT_EMBEDDING_DIM}`,
    );
  }
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`query: k must be a positive integer, got ${k}`);
  }

  const conn = await openConnection(workspaceId);
  const name = tableName(workspaceId);
  const names = await conn.tableNames();
  if (!names.includes(name)) return [];

  const table = await conn.openTable(name);
  const results = await table
    .search(embedding)
    .limit(k)
    .toArray();

  return results.map((row: Record<string, unknown>) => {
    const distance =
      typeof row._distance === "number" && Number.isFinite(row._distance)
        ? row._distance
        : Number.POSITIVE_INFINITY;
    return {
      documentId: String(row.documentId ?? ""),
      chunkId: String(row.chunkId ?? ""),
      text: String(row.text ?? ""),
      sourceFilename: String(row.sourceFilename ?? ""),
      distance,
    };
  });
}

/**
 * Remove all chunks for `documentId` from the workspace's table.
 * Used when the API layer deletes a SemanticDocument row.
 */
export async function removeDocument(
  workspaceId: string,
  documentId: string,
): Promise<{ removed: boolean }> {
  if (!documentId || documentId.trim() === "") {
    throw new Error("removeDocument: documentId must be a non-empty string");
  }
  // Escape single quotes in the doc id defensively. cuids are
  // alphanumeric so this is paranoid but cheap.
  const safeId = documentId.replace(/'/g, "''");
  const conn = await openConnection(workspaceId);
  const name = tableName(workspaceId);
  const names = await conn.tableNames();
  if (!names.includes(name)) return { removed: false };

  const table = await conn.openTable(name);
  await table.delete(`documentId = '${safeId}'`);
  return { removed: true };
}

/**
 * Count chunks currently in the workspace's table. Useful for the
 * documents listing endpoint and for debugging "did the embed actually
 * land".
 */
export async function countChunks(workspaceId: string): Promise<number> {
  const conn = await openConnection(workspaceId);
  const name = tableName(workspaceId);
  const names = await conn.tableNames();
  if (!names.includes(name)) return 0;
  const table = await conn.openTable(name);
  return await table.countRows();
}

/**
 * Test-only helper: nuke the workspace's on-disk LanceDB directory.
 * Used by Jest tests to keep `data/lancedb` clean between runs.
 */
export async function __resetWorkspaceForTests(
  workspaceId: string,
): Promise<void> {
  const dir = workspaceDbDir(workspaceId);
  await fs.rm(dir, { recursive: true, force: true });
}
