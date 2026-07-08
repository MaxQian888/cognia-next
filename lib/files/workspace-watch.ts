// Desktop filesystem watcher for the project editor. Reuses the exact
// `plugin_fs_watch` contract the plugin runtime uses (`lib/plugin/core/
// context.ts`): a recursive `notify` watch keyed by `watchId`, emitting
// `plugin-fs-watch:<watchId>` CustomEvents on `window` with a `{ kind, path }`
// detail. Desktop-only — on web/mobile there is no local disk to watch, so the
// watcher is a no-op and the file tree relies on manual refresh.

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

export interface WorkspaceFsChange {
  kind: "create" | "modify" | "delete" | "any"
  /** Absolute path of the changed entry. */
  path: string
}

/** Reserved owner id — `plugin_fs_watch` only uses it for log namespacing. */
const WATCH_OWNER = "__project-editor__"

let watchCounter = 0

/**
 * Watch `root` recursively for filesystem changes (agents / terminal writing
 * into the project). `onChange` fires per changed path under `root`. Returns a
 * disposer that stops the watch. No-op (returns a no-op disposer) off desktop.
 */
export function watchWorkspace(
  root: string,
  onChange: (change: WorkspaceFsChange) => void
): () => void {
  if (!isTauri() || typeof window === "undefined") return () => {}

  watchCounter += 1
  const watchId = `${WATCH_OWNER}:${root}:${watchCounter}`

  void invoke("plugin_fs_watch", { pluginId: WATCH_OWNER, path: root, watchId }).catch(() => {
    /* watch is best-effort; the tree still refreshes manually */
  })

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<WorkspaceFsChange>).detail
    if (detail && (detail.path === root || detail.path.startsWith(`${root}/`))) {
      onChange(detail)
    }
  }
  window.addEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)

  return () => {
    window.removeEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)
    void invoke("plugin_fs_unwatch", { watchId }).catch(() => {
      /* best-effort teardown */
    })
  }
}
