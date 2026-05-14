/**
 * LRU pool of `file://` URI → Monaco `ITextModel`.
 *
 * VS Code extensions read real files via
 * `vscode.workspace.openTextDocument(file:// URI)`. cognia's reuse layer
 * routes those through `ctx.fs.readText` + creates a Monaco `ITextModel`
 * so the editor APIs (formatting, completion, hover, diagnostics) can run
 * against the file's contents.
 *
 * Cline-class extensions open dozens of files per session. We bound memory
 * by capping the pool at `MAX_MODELS` (default 50) — the LRU eviction
 * policy keeps the most recently touched models alive.
 *
 * Monaco interaction is mediated by a `MonacoModelAdapter` so the pool can
 * be unit-tested without booting Monaco. The renderer's bootstrap installs
 * the real adapter; tests inject an in-memory mock.
 */

export interface MonacoTextModel {
  /** URI string. */
  uri: string
  /** Full text content. */
  getValue(): string
  /** Replace contents. */
  setValue(value: string): void
  /** Detected language id (e.g. `"typescript"`). */
  language: string
  /** Frees the underlying Monaco resource. */
  dispose(): void
  /** True after `dispose()` runs. */
  isDisposed(): boolean
}

export interface MonacoModelAdapter {
  /**
   * Create a Monaco model with the supplied uri + content + language.
   * Throws if the URI already has a live model.
   */
  createModel(input: { uri: string; content: string; language: string }): MonacoTextModel
  /** Look up an existing model by URI, or return undefined. */
  getModel(uri: string): MonacoTextModel | undefined
}

export interface ReadFile {
  (path: string): Promise<{ content: string; language: string }>
}

const DEFAULT_MAX_MODELS = 50

interface PoolEntry {
  uri: string
  model: MonacoTextModel
  /** Wall-clock time of last access — `Date.now()`. */
  lastTouched: number
}

let monacoAdapter: MonacoModelAdapter | null = null
let readFileImpl: ReadFile | null = null
let maxModels = DEFAULT_MAX_MODELS

const pool = new Map<string, PoolEntry>()
const inflight = new Map<string, Promise<MonacoTextModel>>()

/**
 * Configure the pool. Called once on app boot from the renderer's
 * bootstrap with:
 *   - `adapter`: thin wrapper around `monaco.editor.createModel`.
 *   - `readFile`: thin wrapper around `ctx.fs.readText`.
 *
 * Optional `maxModels` sets the LRU cap (default 50).
 */
export function configureFileDocPool(input: {
  adapter: MonacoModelAdapter
  readFile: ReadFile
  maxModels?: number
}): void {
  monacoAdapter = input.adapter
  readFileImpl = input.readFile
  if (typeof input.maxModels === "number" && input.maxModels > 0) {
    maxModels = input.maxModels
  }
}

/**
 * Drop every pooled model. Used on extension reload, on
 * `vscode.workspace.closeAllTextDocuments()`, and on test teardown.
 */
export function disposeAllPooledModels(): void {
  for (const entry of pool.values()) {
    try {
      entry.model.dispose()
    } catch (err) {
      console.warn("file-doc-pool: dispose() threw for", entry.uri, err)
    }
  }
  pool.clear()
  inflight.clear()
}

/**
 * Returns the existing pooled model for a `file://` URI, or `undefined`
 * if not pooled.
 */
export function peekModel(uri: string): MonacoTextModel | undefined {
  const entry = pool.get(uri)
  if (!entry) return undefined
  // Re-use any model the renderer already created elsewhere.
  if (monacoAdapter) {
    const live = monacoAdapter.getModel(uri)
    if (live) return live
  }
  return entry.model
}

/**
 * Get (or create on first touch) the Monaco model for a `file://` URI.
 *
 * Promise coalescing: concurrent `openModel(uri)` calls share one inflight
 * fetch so the file isn't read twice. The returned model has its
 * `lastTouched` updated on every call.
 */
export async function openModel(uri: string): Promise<MonacoTextModel> {
  if (!monacoAdapter || !readFileImpl) {
    throw new Error(
      "file-doc-pool not configured. Call configureFileDocPool() before opening models."
    )
  }
  // Return the existing entry and touch its lastTouched.
  const existing = pool.get(uri)
  if (existing) {
    if (existing.model.isDisposed()) {
      pool.delete(uri)
    } else {
      existing.lastTouched = Date.now()
      return existing.model
    }
  }
  const inflightPromise = inflight.get(uri)
  if (inflightPromise) return inflightPromise

  const loadPromise = (async () => {
    const path = decodeFileUri(uri)
    const { content, language } = await readFileImpl!(path)
    const model = monacoAdapter!.createModel({ uri, content, language })
    pool.set(uri, { uri, model, lastTouched: Date.now() })
    enforceLruCap()
    return model
  })()
  inflight.set(uri, loadPromise)
  try {
    return await loadPromise
  } finally {
    inflight.delete(uri)
  }
}

/** Force the LRU eviction loop to run. Mostly useful for tests. */
export function enforceLruCap(): void {
  if (pool.size <= maxModels) return
  const sorted = [...pool.values()].sort((a, b) => a.lastTouched - b.lastTouched)
  const overage = pool.size - maxModels
  for (let i = 0; i < overage; i += 1) {
    const entry = sorted[i]
    if (!entry) break
    pool.delete(entry.uri)
    try {
      entry.model.dispose()
    } catch (err) {
      console.warn("file-doc-pool: dispose() threw during LRU eviction", err)
    }
  }
}

/** Drop one model from the pool. Idempotent. */
export function closeModel(uri: string): boolean {
  const entry = pool.get(uri)
  if (!entry) return false
  pool.delete(uri)
  try {
    entry.model.dispose()
  } catch (err) {
    console.warn("file-doc-pool: dispose() threw", err)
  }
  return true
}

export function getPoolStats(): { size: number; max: number } {
  return { size: pool.size, max: maxModels }
}

/** Convert `file:///c:/path/foo.js` (or Unix flavour) back into a host path. */
export function decodeFileUri(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`Expected a file:// URI, got "${uri}"`)
  }
  let rest = uri.slice("file://".length)
  if (rest.startsWith("/") && /^\/[A-Za-z]:[\\/]/.test(rest)) {
    // Windows: file:///c:/foo → c:/foo
    rest = rest.slice(1)
  }
  return decodeURIComponent(rest)
}

export function __resetFileDocPoolForTesting(): void {
  for (const entry of pool.values()) {
    try {
      entry.model.dispose()
    } catch {
      /* swallow */
    }
  }
  pool.clear()
  inflight.clear()
  monacoAdapter = null
  readFileImpl = null
  maxModels = DEFAULT_MAX_MODELS
}
