// In-memory code-graph store — the reference implementation and the graceful
// fallback when `better-sqlite3` is unavailable. It mirrors the SQLite store's
// public interface exactly (the parity test suite runs the same assertions
// against both), trading FTS5 ranking for a tokenized inverted index.

// The graph model both stores persist (the columns of ./schema.sql).

export interface GraphNode {
  id: string
  kind: string
  name: string
  qualified_name: string
  file_path: string
  language: string
  start_line: number
  start_col: number
  end_line: number
  end_col: number
  docstring: string | null
  signature: string | null
  visibility: string | null
  is_exported: number
  is_async: number
  is_static: number
  return_type: string | null
  updated_at: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: string
  metadata: string | null
  line: number | null
  col: number | null
  provenance: string
}

export interface UnresolvedRef {
  /** Assigned by the store on insert. */
  id?: number
  from_node_id: string
  reference_name: string
  reference_kind: string
  line: number | null
  col: number | null
  candidates: string | null
  file_path: string
  language: string
}

export interface FileRecord {
  path: string
  content_hash: string
  /** Null only for a file no extractor claims (the column is nullable). */
  language: string | null
  size: number
  modified_at: number
  indexed_at: number
  node_count: number
  errors: string | null
}

/** One file's extracted graph, replaced as a unit. */
export interface FileGraph {
  nodes?: GraphNode[]
  edges?: GraphEdge[]
  unresolved?: UnresolvedRef[]
  file?: FileRecord
}

export interface StoreStats {
  fileCount: number
  nodeCount: number
  edgeCount: number
  unresolvedCount: number
  languages: Record<string, number>
  binding: "sqlite" | "memory"
}

/** The contract both backends implement; the parity suite runs it against each. */
export interface CodeGraphStore {
  binding: "sqlite" | "memory"
  upsertFile(rec: FileRecord): void
  getFile(path: string): FileRecord | null
  allFiles(): FileRecord[]
  deleteFile(path: string): void
  insertNodes(list: readonly GraphNode[] | null | undefined): void
  insertEdges(list: readonly GraphEdge[] | null | undefined): void
  insertUnresolved(list: readonly UnresolvedRef[] | null | undefined): void
  /**
   * Transactional per-file replace: drop the file's existing graph, then
   * insert the new nodes/edges/unresolved and upsert the file record.
   */
  replaceFileGraph(filePath: string, graph?: FileGraph): void
  getNode(idOrQname: string): GraphNode | null
  nodesByName(name: string): GraphNode[]
  allNodes(): GraphNode[]
  searchNodes(query: unknown, opts?: { kind?: string | undefined; limit?: number }): GraphNode[]
  edgesFrom(id: string, kind?: string): GraphEdge[]
  edgesTo(id: string, kind?: string): GraphEdge[]
  allEdges(): GraphEdge[]
  unresolvedAll(): UnresolvedRef[]
  deleteUnresolved(ids: Iterable<number | undefined>): void
  stats(): StoreStats
  close(): void
}

export function createMemoryStore(): CodeGraphStore {
  const files = new Map<string, FileRecord>()
  const nodes = new Map<string, GraphNode>()
  let edges: GraphEdge[] = []
  let unresolved: UnresolvedRef[] = []
  // file_path → Set(nodeId) for fast per-file deletion.
  const nodesByFile = new Map<string, Set<string>>()
  // tokenized inverted index: token → Set(nodeId)
  const invIndex = new Map<string, Set<string>>()

  let nextUnresolvedId = 1

  function indexNode(node: GraphNode): void {
    let set = nodesByFile.get(node.file_path)
    if (!set) {
      set = new Set()
      nodesByFile.set(node.file_path, set)
    }
    set.add(node.id)
    for (const tok of tokenize(node)) {
      let bucket = invIndex.get(tok)
      if (!bucket) {
        bucket = new Set()
        invIndex.set(tok, bucket)
      }
      bucket.add(node.id)
    }
  }

  function deindexNode(node: GraphNode): void {
    const set = nodesByFile.get(node.file_path)
    if (set) set.delete(node.id)
    for (const tok of tokenize(node)) {
      const bucket = invIndex.get(tok)
      if (bucket) {
        bucket.delete(node.id)
        if (bucket.size === 0) invIndex.delete(tok)
      }
    }
  }

  function removeFileGraph(filePath: string): void {
    // Capture the file's node ids BEFORE deleting them, so edges keyed on those
    // sources can still be matched (a post-delete lookup would miss them).
    const ids = nodesByFile.get(filePath)
    const owned = ids ? new Set(ids) : new Set<string>()
    if (ids) {
      for (const id of ids) {
        const node = nodes.get(id)
        if (node) {
          deindexNode(node)
          nodes.delete(id)
        }
      }
      nodesByFile.delete(filePath)
    }
    // Drop edges/unresolved that originated from this file's nodes.
    edges = edges.filter((e) => !owned.has(e.source))
    unresolved = unresolved.filter((u) => u.file_path !== filePath)
  }

  return {
    binding: "memory",

    upsertFile(rec) {
      files.set(rec.path, { ...rec })
    },
    getFile(path) {
      return files.get(path) ?? null
    },
    allFiles() {
      return [...files.values()]
    },
    deleteFile(path) {
      removeFileGraph(path)
      files.delete(path)
    },

    insertNodes(list) {
      for (const node of list ?? []) {
        nodes.set(node.id, node)
        indexNode(node)
      }
    },
    insertEdges(list) {
      for (const e of list ?? []) edges.push(e)
    },
    insertUnresolved(list) {
      for (const u of list ?? []) unresolved.push({ ...u, id: nextUnresolvedId++ })
    },

    replaceFileGraph(filePath, { nodes: ns = [], edges: es = [], unresolved: us = [], file } = {}) {
      removeFileGraph(filePath)
      for (const node of ns) {
        nodes.set(node.id, node)
        indexNode(node)
      }
      for (const e of es) edges.push(e)
      for (const u of us) unresolved.push({ ...u, id: nextUnresolvedId++ })
      if (file) files.set(filePath, { ...file })
    },

    getNode(idOrQname) {
      if (nodes.has(idOrQname)) return nodes.get(idOrQname)!
      for (const node of nodes.values()) {
        if (node.qualified_name === idOrQname) return node
      }
      return null
    },
    nodesByName(name) {
      const out: GraphNode[] = []
      for (const node of nodes.values()) {
        if (node.name === name || node.qualified_name === name) out.push(node)
      }
      return out
    },
    allNodes() {
      return [...nodes.values()]
    },

    searchNodes(query, { kind, limit = 20 } = {}) {
      const terms = tokenizeQuery(query)
      if (terms.length === 0) return []
      const scored: { node: GraphNode; score: number }[] = []
      for (const node of nodes.values()) {
        if (node.kind === "file") continue // mirror the sqlite store (file nodes excluded)
        if (kind && node.kind !== kind) continue
        const score = scoreNode(node, terms, query)
        if (score > 0) scored.push({ node, score })
      }
      scored.sort(
        (a, b) => b.score - a.score || a.node.qualified_name.localeCompare(b.node.qualified_name)
      )
      return scored.slice(0, limit).map((s) => s.node)
    },

    edgesFrom(id, kind) {
      return edges.filter((e) => e.source === id && (!kind || e.kind === kind))
    },
    edgesTo(id, kind) {
      return edges.filter((e) => e.target === id && (!kind || e.kind === kind))
    },
    allEdges() {
      return edges.slice()
    },

    unresolvedAll() {
      return unresolved.slice()
    },
    deleteUnresolved(ids) {
      const drop = new Set(ids)
      unresolved = unresolved.filter((u) => !drop.has(u.id))
    },

    stats() {
      const languages: Record<string, number> = {}
      for (const f of files.values()) {
        // A null language counts under "null", as the SQLite GROUP BY key does.
        const key = String(f.language)
        languages[key] = (languages[key] ?? 0) + 1
      }
      return {
        fileCount: files.size,
        nodeCount: nodes.size,
        edgeCount: edges.length,
        unresolvedCount: unresolved.length,
        languages,
        binding: "memory",
      }
    },

    close() {
      files.clear()
      nodes.clear()
      edges = []
      unresolved = []
      nodesByFile.clear()
      invIndex.clear()
    },
  }
}

// ---- tokenization & scoring ----------------------------------------------

// Split on any non-alphanumeric (including `_`) so snake_case and dotted names
// break into constituent words; camelCase boundaries are split below.
const SPLIT = /[^A-Za-z0-9]+/

/** Tokens for a node: split identifiers on case/separator boundaries. */
function tokenize(node: GraphNode): Set<string> {
  const fields = [node.name, node.qualified_name, node.docstring, node.signature]
  const toks = new Set<string>()
  for (const f of fields) {
    if (!f) continue
    for (const piece of splitIdentifier(String(f))) toks.add(piece.toLowerCase())
  }
  return toks
}

function tokenizeQuery(query: unknown): string[] {
  if (typeof query !== "string") return []
  const out = new Set<string>()
  for (const piece of splitIdentifier(query)) out.add(piece.toLowerCase())
  return [...out]
}

/** camelCase / snake_case / dotted → constituent words + the whole token. */
export function splitIdentifier(text: unknown): string[] {
  const out: string[] = []
  for (const raw of String(text).split(SPLIT)) {
    if (!raw) continue
    out.push(raw)
    // camelCase / PascalCase boundaries
    const camel = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")
    for (const c of camel) if (c && c !== raw) out.push(c)
  }
  return out
}

function scoreNode(node: GraphNode, terms: readonly string[], rawQuery: unknown): number {
  const nameLower = node.name.toLowerCase()
  const qnameLower = node.qualified_name.toLowerCase()
  const q = String(rawQuery).toLowerCase()
  let score = 0
  let matched = false
  if (nameLower === q) {
    score += 100
    matched = true
  } else if (nameLower.includes(q)) {
    score += 25
    matched = true
  }
  if (qnameLower.includes(q)) {
    score += 10
    matched = true
  }
  const tokens = tokenize(node)
  for (const t of terms) {
    if (tokens.has(t)) {
      score += 5
      matched = true
    }
    if (nameLower.includes(t)) {
      score += 2
      matched = true
    }
  }
  // is_exported is only a tiebreak — never enough on its own to "match".
  if (!matched) return 0
  if (node.is_exported) score += 1
  return score
}
