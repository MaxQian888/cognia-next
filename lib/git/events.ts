/**
 * Subscription to the backend `git://status-changed` event. The Rust watcher
 * already debounces fs bursts, but we add a small client-side coalesce so two
 * rapid events (e.g. index + working-tree writes) collapse into one refresh.
 */

import { transport } from "@/lib/tauri"
import { hasGitBridge } from "./commands"

export const GIT_STATUS_CHANGED_EVENT = "git://status-changed"

export interface GitStatusChangedEvent {
  rootDir: string
}

/** Client-side coalesce window (ms) on top of the backend debounce. */
export const GIT_EVENT_COALESCE_MS = 120

/**
 * Subscribe to status-changed events for any repo. The handler fires at most
 * once per `GIT_EVENT_COALESCE_MS` window with the most recent payload. Returns
 * a synchronous unsubscribe (no-op on an unpaired browser). Works over the
 * companion transport too: the desktop forwards `git://status-changed` onto
 * the `/ws/v1/events` bus (see `companion_api/commands.rs`), so remote clients
 * observe the same frames without running the watcher themselves.
 */
export function subscribeGitStatusChanged(
  handler: (event: GitStatusChangedEvent) => void,
  coalesceMs: number = GIT_EVENT_COALESCE_MS
): () => void {
  if (!hasGitBridge()) return () => {}

  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: GitStatusChangedEvent | null = null

  const unsubscribe = transport.subscribe<GitStatusChangedEvent>(
    GIT_STATUS_CHANGED_EVENT,
    (payload) => {
      latest = payload
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (latest) handler(latest)
      }, coalesceMs)
    }
  )

  return () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    unsubscribe()
  }
}
