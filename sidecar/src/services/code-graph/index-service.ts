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

import { loadIgnoreGlobs } from "../../platform/fs/gitignore.ts"
import { isSupportedFile, languageFor } from "./languages/index.ts"
import { extractFile } from "./extractor.ts"
import { resolveAll } from "./resolver-pass.ts"
import { createStore } from "./store.ts"
import { startWatcher, type Watcher } from "./watcher.ts"
import * as graph from "./graph.ts"
import type { Reached } from "./graph.ts"
import { buildContext, type CodeContext } from "./context-builder.ts"
import type { CodeGraphStore, FileRecord, GraphNode, StoreStats } from "./store-memory.ts"

const MAX_FILE_BYTES = 5 * 1024 * 1024
const SYNC_THROTTLE_MS = 1500
const SNIPPET_CACHE_MAX = 64

interface BunCryptoHasher {
  update(bytes: Uint8Array): BunCryptoHasher
  digest(encoding: "hex"): string
}

/** Bun's file and hashing primitives, preferred over node:fs/crypto when whole. */
export interface BunHashRuntime {
  file(path: string): { bytes(): Promise<Uint8Array> }
  CryptoHasher: new (algorithm: string) => BunCryptoHasher
}

export interface IndexServiceOptions {
  root: string
  dbPath?: string
  watch?: boolean
  forceMemory?: boolean
  now?: () => number
  /** Omitted: `globalThis.Bun`. Null: always node:fs/crypto. */
  bunRuntime?: Partial<BunHashRuntime> | null
}

export interface IndexStatus extends Omit<StoreStats, "binding"> {
  /** "sqlite?" before the first query opens a configured on-disk store. */
  binding: string
  indexed: boolean
  root: string
  watching: boolean
  pending: number
}

/** The query surface the code-graph tools call. */
export interface CodeGraphIndex {
  ensureIndexed(): Promise<void>
  /** Re-index what changed since the last sync; resolves to the changed-file count. */
  syncStale(): Promise<number>
  search(query: unknown, opts?: { kind?: string; limit?: number }): GraphNode[]
  getNode(idOrQname: string): GraphNode | null
  snippetFor(node: GraphNode | null | undefined): string
  callers(id: string, depth?: number): Reached[]
  callees(id: string, depth?: number): Reached[]
  impact(id: string, depth?: number): Reached[]
  context(query: string, opts?: { maxNodes?: number; namedSeeds?: readonly string[] }): CodeContext
  files(): FileRecord[]
  status(): IndexStatus
  /** ⚠️ banner text for files pending re-index, or "" when current. */
  stalenessBanner(): string
}

export interface IndexService extends CodeGraphIndex {
  root: string
  readonly binding: string
  dispose(): void
}

function isBunHashRuntime(
  candidate: Partial<BunHashRuntime> | null | undefined
): candidate is BunHashRuntime {
  return typeof candidate?.file === "function" && typeof candidate?.CryptoHasher === "function"
}

export function createIndexService(opts: IndexServiceOptions): IndexService {
  const root = path.resolve(opts.root)
  const now = opts.now ?? Date.now
  const runtimeCandidate =
    opts.bunRuntime === undefined
      ? (globalThis as { Bun?: Partial<BunHashRuntime> }).Bun
      : opts.bunRuntime
  const bunRuntime = isBunHashRuntime(runtimeCandidate) ? runtimeCandidate : null
  const dbPath = opts.forceMemory
    ? undefined
    : (opts.dbPath ?? path.join(root, ".cognia", "codegraph.db"))

  let store: CodeGraphStore | null = null
  let initPromise: Promise<void> | null = null
  let watcher: Watcher | null = null
  let lastSyncAt = 0
  /** files known-changed (from the watcher) awaiting re-index → drives the banner */
  const pendingPaths = new Set<string>()
  /** snippet LRU: relPath → { hash, lines } */
  const snippetCache = new Map<string, { hash: string | null; lines: string[] }>()

  /** The open store; the query methods run only after `ensureIndexed()`. */
  function openStore(): CodeGraphStore {
    if (!store) throw new Error("code graph is not indexed; await ensureIndexed() first")
    return store
  }

  function ensureStore(): CodeGraphStore {
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
  async function listSourceFiles(): Promise<string[]> {
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

  async function hashFile(abs: string): Promise<{ hash: string; size: number; buf: Uint8Array }> {
    if (bunRuntime) {
      const buf = await bunRuntime.file(abs).bytes()
      const hash = new bunRuntime.CryptoHasher("sha1").update(buf).digest("hex")
      return { hash, size: buf.byteLength, buf }
    }
    const buf = await fsp.readFile(abs)
    return { hash: crypto.createHash("sha1").update(buf).digest("hex"), size: buf.length, buf }
  }

  /** Re-extract a single file into the store (or delete it when gone). */
  async function indexOne(rel: string): Promise<{ changed: boolean }> {
    const abs = path.join(root, rel)
    let stat: fs.Stats
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
    const source = new TextDecoder().decode(buf)
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
  async function buildAll(): Promise<void> {
    ensureStore()
    const onDisk = await listSourceFiles()
    const onDiskSet = new Set(onDisk)
    let changed = 0
    for (const rel of onDisk) {
      const r = await indexOne(rel)
      if (r.changed) changed++
    }
    // Drop files removed from disk since the last index.
    const current = openStore()
    for (const f of current.allFiles()) {
      if (!onDiskSet.has(f.path)) {
        current.deleteFile(f.path)
        changed++
      }
    }
    if (changed > 0) resolveAll(current)
    lastSyncAt = now()
  }

  function maybeStartWatcher(): void {
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

  async function ensureIndexed(): Promise<void> {
    if (!initPromise) {
      initPromise = buildAll()
        .then(() => maybeStartWatcher())
        .catch((err: unknown) => {
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
  async function syncStale(): Promise<number> {
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
      const current = openStore()
      for (const f of current.allFiles()) {
        if (!onDiskSet.has(f.path)) {
          current.deleteFile(f.path)
          changed++
        }
      }
      lastSyncAt = now()
    }
    if (changed > 0) resolveAll(openStore())
    return changed
  }

  /** Verbatim source for a node's line range, cached per file+hash. */
  function getSnippet(node: GraphNode | null | undefined): string {
    if (!node || node.kind === "file") return ""
    const rel = node.file_path
    const lines = readLines(rel)
    if (!lines) return node.signature ?? ""
    const start = Math.max(1, node.start_line)
    const end = Math.min(lines.length, node.end_line || start)
    return lines.slice(start - 1, end).join("\n")
  }

  function readLines(rel: string): string[] | null {
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
        const oldest = snippetCache.keys().next()
        if (!oldest.done) snippetCache.delete(oldest.value)
      }
      return lines
    } catch {
      return null
    }
  }

  function toRel(abs: string): string | null {
    const rel = path.relative(root, abs)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join("/")
  }

  // ---- query surface (consumed by the code-graph tools) ----

  return {
    root,
    get binding() {
      return store?.binding ?? (dbPath ? "sqlite?" : "memory")
    },

    ensureIndexed,
    syncStale,

    search(query, { kind, limit } = {}) {
      return openStore().searchNodes(query, { kind, limit })
    },
    getNode(idOrQname) {
      return openStore().getNode(idOrQname)
    },
    snippetFor(node) {
      return getSnippet(node)
    },
    callers(id, depth) {
      return graph.callers(openStore(), id, depth)
    },
    callees(id, depth) {
      return graph.callees(openStore(), id, depth)
    },
    impact(id, depth) {
      return graph.impact(openStore(), id, depth)
    },
    context(query, { maxNodes, namedSeeds } = {}) {
      const current = openStore()
      return buildContext(current, query, {
        getSnippet,
        fileCount: current.stats().fileCount,
        maxNodes,
        namedSeeds,
      })
    },
    files() {
      return openStore().allFiles()
    },

    status() {
      const s: Omit<IndexStatus, "indexed" | "root" | "watching" | "pending"> = store
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
