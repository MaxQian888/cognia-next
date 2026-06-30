// Session code-graph index handle.
//
// Owns the store + parser lifecycle for one agent session rooted at `root`.
// Lazy: nothing is parsed until the first query (`ensureIndexed`). The on-disk
// `.cognia/codegraph.db` persists across sessions, so a warm start is a
// content-hash delta rather than a full re-parse. `syncStale` keeps the graph
// current between tool calls (and is driven by the optional watcher), surfacing
// a ⚠️ banner for files pending re-index.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import fastGlob from "fast-glob"

import { loadIgnoreGlobs } from "../core/gitignore.mjs"
import { isSupportedFile, languageFor } from "./languages/index.mjs"
import { extractFile } from "./extractor.mjs"
import { resolveAll } from "./resolver-pass.mjs"
import { createStore } from "./store.mjs"
import { startWatcher } from "./watcher.mjs"
import * as graph from "./graph.mjs"
import { buildContext } from "./context-builder.mjs"

const MAX_FILE_BYTES = 5 * 1024 * 1024
const SYNC_THROTTLE_MS = 1500
const SNIPPET_CACHE_MAX = 64

/**
 * @param {{
 *   root: string,
 *   dbPath?: string,
 *   watch?: boolean,
 *   forceMemory?: boolean,
 *   now?: () => number,
 * }} opts
 */
export function createIndexService(opts) {
  const root = path.resolve(opts.root)
  const now = opts.now ?? Date.now
  const dbPath = opts.forceMemory
    ? undefined
    : (opts.dbPath ?? path.join(root, ".cognia", "codegraph.db"))

  let store = null
  let initPromise = null
  let watcher = null
  let lastSyncAt = 0
  /** files known-changed (from the watcher) awaiting re-index → drives the banner */
  const pendingPaths = new Set()
  /** snippet LRU: relPath → { hash, lines } */
  const snippetCache = new Map()

  function ensureStore() {
    if (!store) {
      if (dbPath) {
        try {
          fs.mkdirSync(path.dirname(dbPath), { recursive: true })
        } catch {
          /* fall through to memory if .cognia can't be created */
        }
      }
      store = createStore({ dbPath, forceMemory: opts.forceMemory })
    }
    return store
  }

  /** Walk the tree → repo-relative source paths we can extract. */
  async function listSourceFiles() {
    const ignore = await loadIgnoreGlobs(root)
    const all = await fastGlob("**/*", {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore,
    })
    return all.filter((rel) => isSupportedFile(rel))
  }

  async function hashFile(abs) {
    const buf = await fsp.readFile(abs)
    return { hash: crypto.createHash("sha1").update(buf).digest("hex"), size: buf.length, buf }
  }

  /** Re-extract a single file into the store (or delete it when gone). */
  async function indexOne(rel) {
    const abs = path.join(root, rel)
    let stat
    try {
      stat = await fsp.stat(abs)
    } catch {
      ensureStore().deleteFile(rel)
      return { changed: true }
    }
    if (stat.size > MAX_FILE_BYTES) return { changed: false }
    const existing = ensureStore().getFile(rel)
    const { hash, size, buf } = await hashFile(abs)
    if (existing && existing.content_hash === hash) return { changed: false }
    const source = buf.toString("utf-8")
    const result = await extractFile(rel, source)
    ensureStore().replaceFileGraph(rel, {
      nodes: result.nodes,
      edges: result.edges,
      unresolved: result.unresolved,
      file: {
        path: rel,
        content_hash: hash,
        language: result.language ?? languageFor(rel),
        size,
        modified_at: Math.floor(stat.mtimeMs),
        indexed_at: now(),
        node_count: result.nodes.length - 1,
        errors: result.errors.length ? JSON.stringify(result.errors) : null,
      },
    })
    return { changed: true }
  }

  /** Full build (or warm delta): index every changed/new file, drop the gone. */
  async function buildAll() {
    ensureStore()
    const onDisk = await listSourceFiles()
    const onDiskSet = new Set(onDisk)
    let changed = 0
    for (const rel of onDisk) {
      const r = await indexOne(rel)
      if (r.changed) changed++
    }
    // Drop files removed from disk since the last index.
    for (const f of store.allFiles()) {
      if (!onDiskSet.has(f.path)) {
        store.deleteFile(f.path)
        changed++
      }
    }
    if (changed > 0) resolveAll(store)
    lastSyncAt = now()
  }

  function maybeStartWatcher() {
    if (!opts.watch || watcher) return
    watcher = startWatcher(root, {
      accept: (abs) => isSupportedFile(abs),
      onChange: (absPaths) => {
        for (const abs of absPaths) {
          const rel = toRel(abs)
          if (rel) pendingPaths.add(rel)
        }
      },
    })
  }

  async function ensureIndexed() {
    if (!initPromise) {
      initPromise = buildAll()
        .then(() => maybeStartWatcher())
        .catch((err) => {
          initPromise = null
          throw err
        })
    }
    return initPromise
  }

  /**
   * Re-index files known/likely changed since the last sync. When the watcher
   * is active this processes only its pending set; otherwise it throttled-walks
   * for content-hash deltas.
   */
  async function syncStale() {
    await ensureIndexed()
    let changed = 0
    if (pendingPaths.size > 0) {
      const todo = [...pendingPaths]
      pendingPaths.clear()
      for (const rel of todo) {
        const r = await indexOne(rel)
        if (r.changed) {
          changed++
          snippetCache.delete(rel)
        }
      }
    } else if (now() - lastSyncAt >= SYNC_THROTTLE_MS) {
      // No watcher signal (or unsupported) → bounded re-scan.
      const onDisk = await listSourceFiles()
      const onDiskSet = new Set(onDisk)
      for (const rel of onDisk) {
        const r = await indexOne(rel)
        if (r.changed) {
          changed++
          snippetCache.delete(rel)
        }
      }
      for (const f of store.allFiles()) {
        if (!onDiskSet.has(f.path)) {
          store.deleteFile(f.path)
          changed++
        }
      }
      lastSyncAt = now()
    }
    if (changed > 0) resolveAll(store)
    return changed
  }

  /** Verbatim source for a node's line range, cached per file+hash. */
  function getSnippet(node) {
    if (!node || node.kind === "file") return ""
    const rel = node.file_path
    const lines = readLines(rel)
    if (!lines) return node.signature ?? ""
    const start = Math.max(1, node.start_line)
    const end = Math.min(lines.length, node.end_line || start)
    return lines.slice(start - 1, end).join("\n")
  }

  function readLines(rel) {
    const fileRec = store?.getFile(rel)
    const cached = snippetCache.get(rel)
    if (cached && fileRec && cached.hash === fileRec.content_hash) return cached.lines
    try {
      const text = fs.readFileSync(path.join(root, rel), "utf-8")
      const lines = text.split(/\r?\n/)
      // LRU touch
      snippetCache.delete(rel)
      snippetCache.set(rel, { hash: fileRec?.content_hash ?? null, lines })
      if (snippetCache.size > SNIPPET_CACHE_MAX) {
        snippetCache.delete(snippetCache.keys().next().value)
      }
      return lines
    } catch {
      return null
    }
  }

  function toRel(abs) {
    const rel = path.relative(root, abs)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join("/")
  }

  // ---- query surface (consumed by tools.mjs) ----

  return {
    root,
    get binding() {
      return store?.binding ?? (dbPath ? "sqlite?" : "memory")
    },

    ensureIndexed,
    syncStale,

    search(query, { kind, limit } = {}) {
      return store.searchNodes(query, { kind, limit })
    },
    getNode(idOrQname) {
      return store.getNode(idOrQname)
    },
    snippetFor(node) {
      return getSnippet(node)
    },
    callers(id, depth) {
      return graph.callers(store, id, depth)
    },
    callees(id, depth) {
      return graph.callees(store, id, depth)
    },
    impact(id, depth) {
      return graph.impact(store, id, depth)
    },
    context(query, { maxNodes, namedSeeds } = {}) {
      return buildContext(store, query, {
        getSnippet,
        fileCount: store.stats().fileCount,
        maxNodes,
        namedSeeds,
      })
    },
    files() {
      return store.allFiles()
    },

    status() {
      const s = store
        ? store.stats()
        : {
            fileCount: 0,
            nodeCount: 0,
            edgeCount: 0,
            unresolvedCount: 0,
            languages: {},
            binding: this.binding,
          }
      return {
        indexed: !!initPromise,
        root,
        watching: !!watcher?.supported,
        pending: pendingPaths.size,
        ...s,
      }
    },

    /** ⚠️ banner text for files pending re-index, or "" when current. */
    stalenessBanner() {
      if (pendingPaths.size === 0) return ""
      const sample = [...pendingPaths].slice(0, 5).join(", ")
      return (
        `⚠️ ${pendingPaths.size} file(s) changed on disk and are pending re-index ` +
        `(${sample}${pendingPaths.size > 5 ? ", …" : ""}). Read them directly for current content.`
      )
    },

    dispose() {
      try {
        watcher?.dispose()
      } catch {
        /* ignore */
      }
      watcher = null
      try {
        store?.close()
      } catch {
        /* ignore */
      }
      store = null
      initPromise = null
      snippetCache.clear()
    },
  }
}
