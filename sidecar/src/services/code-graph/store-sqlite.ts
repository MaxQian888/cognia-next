// SQLite-backed code-graph store (better-sqlite3 + FTS5).
//
// Public interface is identical to store-memory.ts (the parity test suite runs
// the same assertions against both); this arm adds real FTS5 ranking and
// on-disk persistence. The caller (store.ts) only constructs this when the
// better-sqlite3 binding loaded successfully.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type {
  CodeGraphStore,
  FileGraph,
  FileRecord,
  GraphEdge,
  GraphNode,
  UnresolvedRef,
} from "./store-memory.ts"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = fs.readFileSync(path.join(HERE, "schema.sql"), "utf-8")

/** The statement surface both better-sqlite3 and bun:sqlite provide. */
export interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void
  close(): unknown
}

/** The better-sqlite3 constructor, or a bun:sqlite class adapted to it. */
export type SqliteDatabaseCtor = new (dbPath: string) => SqliteDatabase

type CountRow = { c: number }

const NODE_COLUMNS: readonly (keyof GraphNode)[] = [
  "id",
  "kind",
  "name",
  "qualified_name",
  "file_path",
  "language",
  "start_line",
  "start_col",
  "end_line",
  "end_col",
  "docstring",
  "signature",
  "visibility",
  "is_exported",
  "is_async",
  "is_static",
  "return_type",
  "updated_at",
]

/** A store over `dbPath` (":memory:" or a filesystem path). */
export function createSqliteStore(dbPath: string, Database: SqliteDatabaseCtor): CodeGraphStore {
  const db = new Database(dbPath)
  db.exec(SCHEMA_SQL)

  const stmt = {
    upsertFile: db.prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (@path, @content_hash, @language, @size, @modified_at, @indexed_at, @node_count, @errors)
      ON CONFLICT(path) DO UPDATE SET
        content_hash=excluded.content_hash, language=excluded.language, size=excluded.size,
        modified_at=excluded.modified_at, indexed_at=excluded.indexed_at,
        node_count=excluded.node_count, errors=excluded.errors
    `),
    getFile: db.prepare("SELECT * FROM files WHERE path = ?"),
    allFiles: db.prepare("SELECT * FROM files"),
    insertNode: db.prepare(`
      INSERT OR REPLACE INTO nodes (${NODE_COLUMNS.join(", ")})
      VALUES (${NODE_COLUMNS.map((c) => "@" + c).join(", ")})
    `),
    insertEdge: db.prepare(`
      INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
      VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
    `),
    insertUnresolved: db.prepare(`
      INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
      VALUES (@from_node_id, @reference_name, @reference_kind, @line, @col, @candidates, @file_path, @language)
    `),
    getNodeById: db.prepare("SELECT * FROM nodes WHERE id = ?"),
    getNodeByQname: db.prepare("SELECT * FROM nodes WHERE qualified_name = ? LIMIT 1"),
    nodesByName: db.prepare("SELECT * FROM nodes WHERE name = ? OR qualified_name = ?"),
    allNodes: db.prepare("SELECT * FROM nodes WHERE kind != 'file'"),
    edgesFrom: db.prepare("SELECT * FROM edges WHERE source = ?"),
    edgesFromKind: db.prepare("SELECT * FROM edges WHERE source = ? AND kind = ?"),
    edgesTo: db.prepare("SELECT * FROM edges WHERE target = ?"),
    edgesToKind: db.prepare("SELECT * FROM edges WHERE target = ? AND kind = ?"),
    allEdges: db.prepare("SELECT * FROM edges"),
    unresolvedAll: db.prepare("SELECT * FROM unresolved_refs"),
    deleteEdgesForFile: db.prepare(
      "DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)"
    ),
    deleteUnresolvedForFile: db.prepare("DELETE FROM unresolved_refs WHERE file_path = ?"),
    deleteNodesForFile: db.prepare("DELETE FROM nodes WHERE file_path = ?"),
    deleteFileRow: db.prepare("DELETE FROM files WHERE path = ?"),
    countFiles: db.prepare("SELECT COUNT(*) AS c FROM files"),
    countNodes: db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind != 'file'"),
    countEdges: db.prepare("SELECT COUNT(*) AS c FROM edges"),
    countUnresolved: db.prepare("SELECT COUNT(*) AS c FROM unresolved_refs"),
    langHistogram: db.prepare("SELECT language, COUNT(*) AS c FROM files GROUP BY language"),
    searchLike: db.prepare(`
      SELECT * FROM nodes
      WHERE kind != 'file' AND (name LIKE @like OR qualified_name LIKE @like)
      LIMIT @limit
    `),
  }

  const insertNodesTx = db.transaction((list: readonly GraphNode[]) => {
    for (const n of list) stmt.insertNode.run(normaliseNode(n))
  })
  const insertEdgesTx = db.transaction((list: readonly GraphEdge[]) => {
    for (const e of list) stmt.insertEdge.run(normaliseEdge(e))
  })
  const insertUnresolvedTx = db.transaction((list: readonly UnresolvedRef[]) => {
    for (const u of list) stmt.insertUnresolved.run(normaliseUnresolved(u))
  })

  const removeFileGraph = (filePath: string) => {
    stmt.deleteEdgesForFile.run(filePath)
    stmt.deleteUnresolvedForFile.run(filePath)
    stmt.deleteNodesForFile.run(filePath)
  }

  const replaceFileGraphTx = db.transaction((filePath: string, payload: FileGraph) => {
    removeFileGraph(filePath)
    insertNodesTx(payload.nodes ?? [])
    insertEdgesTx(payload.edges ?? [])
    insertUnresolvedTx(payload.unresolved ?? [])
    if (payload.file) stmt.upsertFile.run(normaliseFile(payload.file))
  })

  return {
    binding: "sqlite",

    upsertFile(rec) {
      stmt.upsertFile.run(normaliseFile(rec))
    },
    getFile(p) {
      return (stmt.getFile.get(p) as FileRecord | undefined) ?? null
    },
    allFiles() {
      return stmt.allFiles.all() as FileRecord[]
    },
    deleteFile(p) {
      removeFileGraph(p)
      stmt.deleteFileRow.run(p)
    },

    insertNodes(list) {
      insertNodesTx(list ?? [])
    },
    insertEdges(list) {
      insertEdgesTx(list ?? [])
    },
    insertUnresolved(list) {
      insertUnresolvedTx(list ?? [])
    },
    replaceFileGraph(filePath, payload = {}) {
      replaceFileGraphTx(filePath, payload)
    },

    getNode(idOrQname) {
      return (
        (stmt.getNodeById.get(idOrQname) as GraphNode | undefined) ??
        (stmt.getNodeByQname.get(idOrQname) as GraphNode | undefined) ??
        null
      )
    },
    nodesByName(name) {
      return stmt.nodesByName.all(name, name) as GraphNode[]
    },
    allNodes() {
      return stmt.allNodes.all() as GraphNode[]
    },

    searchNodes(query, { kind, limit = 20 } = {}) {
      const match = toFtsQuery(query)
      if (!match) return []
      let rows: GraphNode[]
      try {
        // External-content FTS5: join back to nodes via rowid, rank by bm25.
        const sql = kind
          ? `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
             WHERE nodes_fts MATCH @m AND n.kind = @kind ORDER BY bm25(nodes_fts) LIMIT @limit`
          : `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
             WHERE nodes_fts MATCH @m ORDER BY bm25(nodes_fts) LIMIT @limit`
        rows = db.prepare(sql).all({ m: match, kind, limit }) as GraphNode[]
      } catch {
        // FTS parse failure → LIKE fallback.
        rows = (stmt.searchLike.all({ like: `%${String(query)}%`, limit }) as GraphNode[]).filter(
          (n) => !kind || n.kind === kind
        )
      }
      return rows.filter((n) => n.kind !== "file")
    },

    edgesFrom(id, kind) {
      return (kind ? stmt.edgesFromKind.all(id, kind) : stmt.edgesFrom.all(id)) as GraphEdge[]
    },
    edgesTo(id, kind) {
      return (kind ? stmt.edgesToKind.all(id, kind) : stmt.edgesTo.all(id)) as GraphEdge[]
    },
    allEdges() {
      return stmt.allEdges.all() as GraphEdge[]
    },

    unresolvedAll() {
      return stmt.unresolvedAll.all() as UnresolvedRef[]
    },
    deleteUnresolved(idList) {
      const ids = idList ? [...idList] : []
      if (ids.length === 0) return
      const del = db.prepare(
        `DELETE FROM unresolved_refs WHERE id IN (${ids.map(() => "?").join(",")})`
      )
      del.run(...ids)
    },

    stats() {
      const languages: Record<string, number> = {}
      for (const row of stmt.langHistogram.all() as { language: string | null; c: number }[])
        languages[String(row.language)] = row.c
      return {
        fileCount: (stmt.countFiles.get() as CountRow).c,
        nodeCount: (stmt.countNodes.get() as CountRow).c,
        edgeCount: (stmt.countEdges.get() as CountRow).c,
        unresolvedCount: (stmt.countUnresolved.get() as CountRow).c,
        languages,
        binding: "sqlite",
      }
    },

    close() {
      db.close()
    },
  }
}

// ---- FTS query building ---------------------------------------------------

/**
 * Build a safe FTS5 MATCH expression from a free-text query: split into tokens,
 * quote each, OR them with a prefix wildcard. Returns null for empty input.
 */
export function toFtsQuery(query: unknown): string | null {
  if (typeof query !== "string") return null
  const tokens = query.match(/[A-Za-z0-9]+/g)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(" OR ")
}

// ---- normalisation (fill missing columns so prepared stmts don't throw) ---

function normaliseNode(n: Partial<GraphNode>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const col of NODE_COLUMNS) out[col] = n[col] ?? defaultFor(col)
  return out
}
function defaultFor(col: string): number | null {
  if (col === "is_exported" || col === "is_async" || col === "is_static") return 0
  if (col === "start_line" || col === "start_col" || col === "end_line" || col === "end_col")
    return 0
  if (col === "updated_at") return 0
  return null
}
function normaliseEdge(e: GraphEdge): Record<string, unknown> {
  return {
    source: e.source,
    target: e.target,
    kind: e.kind,
    metadata: e.metadata ?? null,
    line: e.line ?? null,
    col: e.col ?? null,
    provenance: e.provenance ?? null,
  }
}
function normaliseUnresolved(u: UnresolvedRef): Record<string, unknown> {
  return {
    from_node_id: u.from_node_id,
    reference_name: u.reference_name,
    reference_kind: u.reference_kind,
    line: u.line ?? null,
    col: u.col ?? null,
    candidates: u.candidates ?? null,
    file_path: u.file_path,
    language: u.language ?? null,
  }
}
function normaliseFile(f: Partial<FileRecord> & { path: string }): Record<string, unknown> {
  return {
    path: f.path,
    content_hash: f.content_hash ?? null,
    language: f.language ?? null,
    size: f.size ?? 0,
    modified_at: f.modified_at ?? 0,
    indexed_at: f.indexed_at ?? 0,
    node_count: f.node_count ?? 0,
    errors: f.errors ?? null,
  }
}
