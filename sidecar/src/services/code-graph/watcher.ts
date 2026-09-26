// Optional in-session file watcher.
//
// Uses `node:fs.watch` with recursive mode (supported on Windows + macOS; not
// Linux). When recursive watching is unsupported it degrades to a no-op watcher
// (`supported:false`) — the index-service then relies on per-query staleness
// scans instead. Edits are debounced (default 2000ms, env-overridable) so a
// burst collapses into a single `onChange(paths)` callback.

import fs from "node:fs"
import path from "node:path"

const MIN_DEBOUNCE = 100
const MAX_DEBOUNCE = 60000

/** The slice of `node:fs` the watcher uses, injectable for tests. */
export interface WatchFs {
  watch(
    root: string,
    options: { recursive: boolean },
    listener: (event: string, filename: string | null) => void
  ): { close(): void }
}

export interface WatcherOptions {
  /** Absolute paths that changed within one debounce window. */
  onChange: (paths: string[]) => void
  accept?: (absPath: string) => boolean
  debounceMs?: number
  fsImpl?: WatchFs
}

export interface Watcher {
  supported: boolean
  dispose(): void
}

/** Resolve the debounce window from env, clamped to [100ms, 60s]. */
export function resolveDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CODEGRAPH_WATCH_DEBOUNCE_MS)
  if (!Number.isFinite(raw)) return 2000
  return Math.max(MIN_DEBOUNCE, Math.min(MAX_DEBOUNCE, raw))
}

/**
 * Start watching `root`. Returns `{ supported, dispose }`. `onChange` receives
 * an array of absolute paths that changed within a debounce window, already
 * filtered by `accept(absPath)` when provided.
 */
export function startWatcher(root: string, opts: WatcherOptions): Watcher {
  const { onChange, accept, fsImpl = fs } = opts
  const debounceMs = opts.debounceMs ?? resolveDebounceMs()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: { close(): void } | null = null

  const flush = (): void => {
    timer = null
    if (pending.size === 0) return
    const paths = [...pending]
    pending.clear()
    try {
      onChange(paths)
    } catch {
      /* never let a sync error kill the watcher */
    }
  }

  const schedule = (filename: string | null): void => {
    if (!filename) return
    const abs = path.isAbsolute(filename) ? filename : path.join(root, filename)
    if (accept && !accept(abs)) return
    pending.add(abs)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
    if (typeof timer.unref === "function") timer.unref()
  }

  try {
    watcher = fsImpl.watch(root, { recursive: true }, (_event, filename) => schedule(filename))
  } catch {
    return { supported: false, dispose() {} }
  }

  return {
    supported: true,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
      try {
        watcher?.close()
      } catch {
        /* ignore */
      }
    },
  }
}
