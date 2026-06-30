// Reference resolution pass.
//
// The extractor can only see one file, so cross-file calls/imports/inheritance
// land in `unresolved_refs`. `resolveAll(store)` links what it can into concrete
// `edges`, deletes the refs it resolved, and leaves the rest (e.g. third-party
// symbols) for a later pass once more files are indexed. Idempotent: resolved
// refs are removed, so re-running never double-inserts.
//
// Resolution is best-effort name matching — an augmentation of, not a
// replacement for, the LSP tools. Every synthesized edge stamps `provenance`
// and, when the target name was ambiguous, the alternative candidate ids in
// `metadata` so low-confidence links remain auditable.

import path from "node:path"

const JS_IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
const JS_INDEX_FILES = JS_IMPORT_EXTS.map((e) => `index${e}`)

/**
 * @param {object} store
 * @returns {{ resolved: number, edgesAdded: number, remaining: number }}
 */
export function resolveAll(store) {
  const unresolved = store.unresolvedAll()
  if (unresolved.length === 0) {
    return { resolved: 0, edgesAdded: 0, remaining: 0 }
  }

  const filePaths = store.allFiles().map((f) => f.path)
  const filePathSet = new Set(filePaths)

  const edges = []
  const resolvedIds = []

  for (const ref of unresolved) {
    let edge = null
    if (ref.reference_kind === "imports") {
      edge = resolveImport(store, ref, filePathSet)
    } else {
      edge = resolveSymbolRef(store, ref)
    }
    if (edge) {
      edges.push(edge)
      resolvedIds.push(ref.id)
    }
  }

  if (edges.length > 0) store.insertEdges(edges)
  if (resolvedIds.length > 0) store.deleteUnresolved(resolvedIds)

  return {
    resolved: resolvedIds.length,
    edgesAdded: edges.length,
    remaining: unresolved.length - resolvedIds.length,
  }
}

/** Link a calls/extends/implements/references ref by symbol name. */
function resolveSymbolRef(store, ref) {
  const candidates = store.nodesByName(ref.reference_name).filter((n) => n.kind !== "file")
  if (candidates.length === 0) return null
  const fromNode = store.getNode(ref.from_node_id)
  const best = pickBest(candidates, fromNode, ref.reference_kind)
  if (!best) return null
  // Don't link a node to itself (recursive calls add no graph value).
  if (best.id === ref.from_node_id) return null
  const others = candidates.filter((c) => c.id !== best.id).map((c) => c.id)
  return {
    source: ref.from_node_id,
    target: best.id,
    kind: ref.reference_kind,
    metadata: others.length ? JSON.stringify({ candidates: others }) : null,
    line: ref.line ?? null,
    col: ref.col ?? null,
    provenance: others.length ? "resolved-ambiguous" : "resolved",
  }
}

/**
 * Choose the best target among same-named candidates:
 *   1. prefer a candidate in the same file as the reference
 *   2. for calls, prefer function/method/constant over types
 *   3. prefer exported symbols
 *   4. else the lexically-first qualified name (stable tiebreak)
 */
function pickBest(candidates, fromNode, kind) {
  const fromFile = fromNode?.file_path
  const callKindPref = kind === "calls" || kind === "references"
  const score = (c) => {
    let s = 0
    if (fromFile && c.file_path === fromFile) s += 100
    if (callKindPref && (c.kind === "function" || c.kind === "method")) s += 20
    if (
      !callKindPref &&
      (c.kind === "class" || c.kind === "interface" || c.kind === "struct" || c.kind === "trait")
    )
      s += 20
    if (c.is_exported) s += 5
    return s
  }
  return [...candidates].sort(
    (a, b) => score(b) - score(a) || a.qualified_name.localeCompare(b.qualified_name)
  )[0]
}

/**
 * Resolve an import ref to a target file node. JS/TS relative specifiers are
 * resolved against the importing file's directory with extension/index probing;
 * other specifiers (bare packages, python dotted, rust crate paths) are matched
 * by trailing-path heuristics against the known file set.
 */
function resolveImport(store, ref, filePathSet) {
  const target = resolveImportTarget(ref, filePathSet)
  if (!target) return null
  return {
    source: ref.from_node_id, // the importing file node
    target,
    kind: "imports",
    metadata: null,
    line: ref.line ?? null,
    col: ref.col ?? null,
    provenance: "resolved",
  }
}

/** Returns the matched file path (= file node id) or null. */
export function resolveImportTarget(ref, filePathSet) {
  const spec = ref.reference_name
  const fromDir = posixDir(ref.file_path)

  if (spec.startsWith(".")) {
    const base = posixJoin(fromDir, spec)
    // exact, then with each extension, then index files.
    if (filePathSet.has(base)) return base
    for (const ext of JS_IMPORT_EXTS) {
      if (filePathSet.has(base + ext)) return base + ext
    }
    for (const idx of JS_INDEX_FILES) {
      const cand = posixJoin(base, idx)
      if (filePathSet.has(cand)) return cand
    }
    return null
  }

  // Non-relative: best-effort suffix match (python `a.b.c` → a/b/c.py;
  // rust `crate::foo::Bar` → foo.rs / foo/mod.rs). Convert separators to "/".
  const parts = spec
    .split(/::|\./)
    .filter((p) => p && p !== "crate" && p !== "self" && p !== "super")
  if (parts.length === 0) return null
  const tail = parts.join("/")
  for (const p of filePathSet) {
    const noExt = stripKnownExt(p)
    if (noExt.endsWith(`/${tail}`) || noExt === tail || noExt.endsWith(`/${tail}/mod`)) {
      return p
    }
  }
  return null
}

function posixDir(p) {
  return path.posix.dirname(p.split(path.sep).join("/"))
}
function posixJoin(a, b) {
  return path.posix.normalize(path.posix.join(a, b)).replace(/^\.\//, "")
}
function stripKnownExt(p) {
  const norm = p.split(path.sep).join("/")
  const ext = path.posix.extname(norm)
  return ext ? norm.slice(0, -ext.length) : norm
}
