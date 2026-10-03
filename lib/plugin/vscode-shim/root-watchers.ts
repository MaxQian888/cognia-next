/**
 * One native watch per folder, shared by everything in the VS Code shim
 * that needs a folder's file changes (extensions' file watchers, the
 * documents hosts hold that are not in an editor). The watch starts with
 * its first listener and stops with its last.
 */

import { watchWorkspace, type WorkspaceFsChange } from "@/lib/files/workspace-watch"

type Listener = (change: WorkspaceFsChange) => void
type Watch = (root: string, onChange: Listener) => () => void

let watch: Watch = watchWorkspace
const roots = new Map<string, { stop: () => void; listeners: Set<Listener> }>()

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")

/** Listen to file changes under `root`; returns the unsubscribe. */
export function watchRoot(root: string, listener: Listener): () => void {
  const key = normalize(root)
  let entry = roots.get(key)
  if (!entry) {
    const listeners = new Set<Listener>()
    const stop = watch(key, (change) => {
      for (const each of [...listeners]) each({ ...change, path: change.path.replace(/\\/g, "/") })
    })
    entry = { stop, listeners }
    roots.set(key, entry)
  }
  const current = entry
  current.listeners.add(listener)
  let done = false
  return () => {
    if (done) return
    done = true
    current.listeners.delete(listener)
    if (current.listeners.size === 0 && roots.get(key) === current) {
      roots.delete(key)
      current.stop()
    }
  }
}

/** The folders watched now, for tests and diagnostics. */
export function watchedRoots(): string[] {
  return [...roots.keys()]
}

export function __configureRootWatchersForTesting(next: Watch | null): void {
  for (const entry of roots.values()) entry.stop()
  roots.clear()
  watch = next ?? watchWorkspace
}
