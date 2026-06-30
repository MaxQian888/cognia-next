// SQLite-backed code-graph store (better-sqlite3 + FTS5).
//
// Public interface is identical to store-memory.mjs (the parity test suite runs
// the same assertions against both); this arm adds real FTS5 ranking and
// on-disk persistence. The caller (store.mjs) only constructs this when the
// better-sqlite3 binding loaded successfully.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = fs.readFileSync(path.join(HERE, "schema.sql"), "utf-8")

const NODE_COLUMNS = [
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

/**
 * @param {string} dbPath  ":memory:" or a filesystem path
 * @param {(...a:any[]) => any} Database  the better-sqlite3 constructor
 */
export function createSqliteStore(dbPath, Database) {
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

  const insertNodesTx = db.transaction((list) => {
    for (const n of list) stmt.insertNode.run(normaliseNode(n))
  })
  const insertEdgesTx = db.transaction((list) => {
    for (const e of list) stmt.insertEdge.run(normaliseEdge(e))
  })
  const insertUnresolvedTx = db.transaction((list) => {
    for (const u of list) stmt.insertUnresolved.run(normaliseUnresolved(u))
  })

  const removeFileGraph = (filePath) => {
    stmt.deleteEdgesForFile.run(filePath)
    stmt.deleteUnresolvedForFile.run(filePath)
    stmt.deleteNodesForFile.run(filePath)
  }

  const replaceFileGraphTx = db.transaction((filePath, payload) => {
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
      return stmt.getFile.get(p) ?? null
    },
    allFiles() {
      return stmt.allFiles.all()
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
      return stmt.getNodeById.get(idOrQname) ?? stmt.getNodeByQname.get(idOrQname) ?? null
    },
    nodesByName(name) {
      return stmt.nodesByName.all(name, name)
    },
    allNodes() {
      return stmt.allNodes.all()
    },

    searchNodes(query, { kind, limit = 20 } = {}) {
      const match = toFtsQuery(query)
      if (!match) return []
      let rows
      try {
        // External-content FTS5: join back to nodes via rowid, rank by bm25.
        const sql = kind
          ? `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
             WHERE nodes_fts MATCH @m AND n.kind = @kind ORDER BY bm25(nodes_fts) LIMIT @limit`
          : `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
             WHERE nodes_fts MATCH @m ORDER BY bm25(nodes_fts) LIMIT @limit`
        rows = db.prepare(sql).all({ m: match, kind, limit })
      } catch {
        // FTS parse failure → LIKE fallback.
        rows = stmt.searchLike
          .all({ like: `%${String(query)}%`, limit })
          .filter((n) => !kind || n.kind === kind)
      }
      return rows.filter((n) => n.kind !== "file")
    },

    edgesFrom(id, kind) {
      return kind ? stmt.edgesFromKind.all(id, kind) : stmt.edgesFrom.all(id)
    },
    edgesTo(id, kind) {
      return kind ? stmt.edgesToKind.all(id, kind) : stmt.edgesTo.all(id)
    },
    allEdges() {
      return stmt.allEdges.all()
    },

    unresolvedAll() {
      return stmt.unresolvedAll.all()
    },
    deleteUnresolved(ids) {
      if (!ids || ids.length === 0) return
      const del = db.prepare(
        `DELETE FROM unresolved_refs WHERE id IN (${ids.map(() => "?").join(",")})`
      )
      del.run(...ids)
    },

    stats() {
      const languages = {}
      for (const row of stmt.langHistogram.all()) languages[row.language] = row.c
      return {
        fileCount: stmt.countFiles.get().c,
        nodeCount: stmt.countNodes.get().c,
        edgeCount: stmt.countEdges.get().c,
        unresolvedCount: stmt.countUnresolved.get().c,
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
export function toFtsQuery(query) {
  if (typeof query !== "string") return null
  const tokens = query.match(/[A-Za-z0-9]+/g)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(" OR ")
}

// ---- normalisation (fill missing columns so prepared stmts don't throw) ---

function normaliseNode(n) {
  const out = {}
  for (const col of NODE_COLUMNS) out[col] = n[col] ?? defaultFor(col)
  return out
}
function defaultFor(col) {
  if (col === "is_exported" || col === "is_async" || col === "is_static") return 0
  if (col === "start_line" || col === "start_col" || col === "end_line" || col === "end_col")
    return 0
  if (col === "updated_at") return 0
  return null
}
function normaliseEdge(e) {
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
function normaliseUnresolved(u) {
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
function normaliseFile(f) {
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
