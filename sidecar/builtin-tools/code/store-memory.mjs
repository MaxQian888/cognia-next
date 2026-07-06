// In-memory code-graph store — the reference implementation and the graceful
// fallback when `better-sqlite3` is unavailable. It mirrors the SQLite store's
// public interface exactly (the parity test suite runs the same assertions
// against both), trading FTS5 ranking for a tokenized inverted index.

/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} kind
 * @property {string} name
 * @property {string} qualified_name
 * @property {string} file_path
 * @property {string} language
 * @property {number} start_line
 * @property {number} start_col
 * @property {number} end_line
 * @property {number} end_col
 * @property {string|null} docstring
 * @property {string|null} signature
 * @property {string|null} visibility
 * @property {number} is_exported
 * @property {number} is_async
 * @property {number} is_static
 * @property {string|null} return_type
 * @property {number} updated_at
 *
 * @typedef {Object} GraphEdge
 * @property {string} source
 * @property {string} target
 * @property {string} kind
 * @property {string|null} metadata
 * @property {number|null} line
 * @property {number|null} col
 * @property {string} provenance
 *
 * @typedef {Object} UnresolvedRef
 * @property {string} from_node_id
 * @property {string} reference_name
 * @property {string} reference_kind
 * @property {number|null} line
 * @property {number|null} col
 * @property {string|null} candidates
 * @property {string} file_path
 * @property {string} language
 *
 * @typedef {Object} FileRecord
 * @property {string} path
 * @property {string} content_hash
 * @property {string} language
 * @property {number} size
 * @property {number} modified_at
 * @property {number} indexed_at
 * @property {number} node_count
 * @property {string|null} errors
 */

export function createMemoryStore() {
  /** @type {Map<string, FileRecord>} */
  const files = new Map()
  /** @type {Map<string, GraphNode>} */
  const nodes = new Map()
  /** @type {GraphEdge[]} */
  let edges = []
  /** @type {UnresolvedRef[]} */
  let unresolved = []
  // file_path → Set(nodeId) for fast per-file deletion.
  /** @type {Map<string, Set<string>>} */
  const nodesByFile = new Map()
  // tokenized inverted index: token → Set(nodeId)
  /** @type {Map<string, Set<string>>} */
  const invIndex = new Map()

  let nextUnresolvedId = 1

  function indexNode(node) {
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

  function deindexNode(node) {
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

  function removeFileGraph(filePath) {
    // Capture the file's node ids BEFORE deleting them, so edges keyed on those
    // sources can still be matched (a post-delete lookup would miss them).
    const ids = nodesByFile.get(filePath)
    const owned = ids ? new Set(ids) : new Set()
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

    /**
     * Transactional per-file replace: drop the file's existing graph, then
     * insert the new nodes/edges/unresolved and upsert the file record.
     */
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
      if (nodes.has(idOrQname)) return nodes.get(idOrQname)
      for (const node of nodes.values()) {
        if (node.qualified_name === idOrQname) return node
      }
      return null
    },
    nodesByName(name) {
      const out = []
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
      const scored = []
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
      const languages = {}
      for (const f of files.values()) {
        languages[f.language] = (languages[f.language] ?? 0) + 1
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
function tokenize(node) {
  const fields = [node.name, node.qualified_name, node.docstring, node.signature]
  const toks = new Set()
  for (const f of fields) {
    if (!f) continue
    for (const piece of splitIdentifier(String(f))) toks.add(piece.toLowerCase())
  }
  return toks
}

function tokenizeQuery(query) {
  if (typeof query !== "string") return []
  const out = new Set()
  for (const piece of splitIdentifier(query)) out.add(piece.toLowerCase())
  return [...out]
}

/** camelCase / snake_case / dotted → constituent words + the whole token. */
export function splitIdentifier(text) {
  const out = []
  for (const raw of String(text).split(SPLIT)) {
    if (!raw) continue
    out.push(raw)
    // camelCase / PascalCase boundaries
    const camel = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")
    for (const c of camel) if (c && c !== raw) out.push(c)
  }
  return out
}

function scoreNode(node, terms, rawQuery) {
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
