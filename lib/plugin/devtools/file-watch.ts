/**
 * In-app plugin file watcher.
 *
 * Replaces the 546-line `hot-reload.ts`, which had no production caller: its
 * only importers were the retired DevTools panel and two modules that were
 * themselves unreachable. The Rust watcher it was built on is real
 * (`plugin_watch_start` holds a `notify::RecommendedWatcher` and emits
 * `plugin:file-change`), so this module keeps that capability and drops the
 * dead scaffolding around it.
 *
 * What it does: watch the install directories of locally-sourced plugins and,
 * after a debounce, put each changed plugin through the same verified reload
 * the CLI uses (`pluginDevReload`), which only reports success once the
 * lifecycle coordinator reports a new active generation.
 *
 * What it deliberately does NOT do: build anything. The app has no compiler.
 * That is why `wasm` and `vscode-extension` plugins are reported as
 * `needs-build` rather than watched. A source edit for those produces no new
 * artifact, so reloading would re-activate the same bytes and look like a
 * hot reload that changed nothing. Those runtimes need `cognia plugin dev`,
 * which builds and installs before asking for the reload.
 */

import type { Plugin } from "@/types/plugin"
import { isTauri } from "@/lib/tauri"
import {
  pluginDevReload,
  type PluginDevReloadResult,
} from "@/lib/cli-bridge/handlers/plugin-dev-reload"
import { recordHotReloadEvent } from "@/stores/plugin-runtime/hot-reload-history-store"
import { loggers } from "../core/logger"

/** The event the Rust watcher emits. It carries no plugin id, only a path. */
export const FILE_CHANGE_EVENT = "plugin:file-change"

/** Marks history rows this watcher produced, as opposed to the CLI's. */
export const APP_WATCH_SOURCE = "app"

/** Matches the old module's debounce so rapid saves still coalesce. */
export const DEFAULT_DEBOUNCE_MS = 300

export interface PluginFileChangePayload {
  type: "create" | "modify" | "delete" | "rename"
  path: string
  timestamp: number
}

export type WatchIneligibility =
  /** No compiler in the app, so a source edit yields no new artifact. */
  | "needs-build"
  /** Installed from a package, so there is no source tree on disk to watch. */
  | "not-local-source"
  /** The watcher is a Tauri command. */
  | "desktop-required"

export type WatchEligibility =
  { watchable: true } | { watchable: false; reason: WatchIneligibility }

/** Runtimes whose on-disk artifact is not the source the author edits. */
const NEEDS_BUILD = new Set<Plugin["manifest"]["type"]>(["wasm", "vscode-extension"])
/** Sources that have an author-owned directory on disk. */
const LOCAL_SOURCES = new Set<Plugin["source"]>(["dev", "local"])

/**
 * Whether this watcher can do anything useful for a plugin, and if not, why.
 *
 * Exported because the reason is shown in the UI: a plugin that silently never
 * reloads is indistinguishable from a broken watcher.
 */
export function watchEligibility(
  plugin: Pick<Plugin, "source" | "manifest">,
  isDesktop: boolean
): WatchEligibility {
  if (!isDesktop) return { watchable: false, reason: "desktop-required" }
  if (!LOCAL_SOURCES.has(plugin.source)) {
    return { watchable: false, reason: "not-local-source" }
  }
  if (NEEDS_BUILD.has(plugin.manifest.type)) {
    return { watchable: false, reason: "needs-build" }
  }
  return { watchable: true }
}

interface WatchedRoot {
  pluginId: string
  root: string
}

/**
 * Map a changed path back to a plugin by longest matching install root.
 *
 * The previous implementation guessed with a `/plugins/<id>/` regex and then
 * fell back to `filePath.includes(pluginId)`, which credits the wrong plugin
 * whenever one id is a substring of another or a path merely mentions an id.
 * The roots are known exactly here, so nothing needs guessing.
 */
export function resolveWatchedPluginId(
  roots: readonly WatchedRoot[],
  changedPath: string
): string | null {
  let best: WatchedRoot | null = null
  for (const candidate of roots) {
    if (!isUnder(changedPath, candidate.root)) continue
    if (!best || candidate.root.length > best.root.length) best = candidate
  }
  return best?.pluginId ?? null
}

function isUnder(changedPath: string, root: string): boolean {
  if (changedPath === root) return true
  const normalizedRoot = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root
  return (
    changedPath.startsWith(`${normalizedRoot}/`) || changedPath.startsWith(`${normalizedRoot}\\`)
  )
}

export interface PluginFileWatchDependencies {
  isDesktop: () => boolean
  startWatch: (paths: string[]) => Promise<void>
  stopWatch: () => Promise<void>
  listen: (
    event: string,
    handler: (payload: PluginFileChangePayload) => void
  ) => Promise<() => void>
  reload: (pluginId: string, attempt: number, sessionId: string) => Promise<PluginDevReloadResult>
  record: typeof recordHotReloadEvent
  now: () => number
  debounceMs: number
  /** Stable id for this watcher run, echoed into every reload request. */
  sessionId: string
}

export interface PluginFileWatchHandle {
  /** Plugin ids this run is actually watching. */
  watchedPluginIds: string[]
  stop: () => Promise<void>
}

/**
 * Start watching. Returns a handle even when nothing is eligible, so a caller
 * can render "watching 0 of 3" instead of failing.
 */
export async function startPluginFileWatch(
  plugins: readonly Plugin[],
  overrides: Partial<PluginFileWatchDependencies> = {}
): Promise<PluginFileWatchHandle> {
  const deps = { ...defaultDependencies(), ...overrides }
  const roots: WatchedRoot[] = []
  for (const plugin of plugins) {
    if (!watchEligibility(plugin, deps.isDesktop()).watchable) continue
    if (!plugin.path) continue
    roots.push({ pluginId: plugin.manifest.id, root: plugin.path })
  }

  if (roots.length === 0) {
    return { watchedPluginIds: [], stop: async () => {} }
  }

  await deps.startWatch(roots.map((entry) => entry.root))

  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const attempts = new Map<string, number>()
  let stopped = false

  const unlisten = await deps.listen(FILE_CHANGE_EVENT, (payload) => {
    if (stopped) return
    const pluginId = resolveWatchedPluginId(roots, payload.path)
    if (!pluginId) return

    const existing = pending.get(pluginId)
    if (existing) clearTimeout(existing)
    pending.set(
      pluginId,
      setTimeout(() => {
        pending.delete(pluginId)
        void runReload(pluginId)
      }, deps.debounceMs)
    )
  })

  async function runReload(pluginId: string): Promise<void> {
    if (stopped) return
    const attempt = (attempts.get(pluginId) ?? 0) + 1
    attempts.set(pluginId, attempt)
    deps.record({
      pluginId,
      source: APP_WATCH_SOURCE,
      kind: "hot-reload",
      status: "in-progress",
      timestamp: deps.now(),
    })
    try {
      const result = await deps.reload(pluginId, attempt, deps.sessionId)
      deps.record({
        pluginId,
        source: APP_WATCH_SOURCE,
        kind: "hot-reload",
        status: result.ok ? "success" : "failed",
        timestamp: deps.now(),
        ...(result.error ? { note: result.error.message } : {}),
      })
    } catch (error) {
      // A throw here is the watcher failing, not the plugin. Recording it as a
      // failed row is what tells the author the difference between "my plugin
      // is broken" and "nothing is watching any more".
      const message = error instanceof Error ? error.message : String(error)
      loggers.hotReload.warn(`[file-watch] reload threw for ${pluginId}`, { error: message })
      deps.record({
        pluginId,
        source: APP_WATCH_SOURCE,
        kind: "hot-reload",
        status: "failed",
        timestamp: deps.now(),
        note: message,
      })
    }
  }

  return {
    watchedPluginIds: roots.map((entry) => entry.pluginId),
    stop: async () => {
      stopped = true
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      unlisten()
      await deps.stopWatch()
    },
  }
}

function defaultDependencies(): PluginFileWatchDependencies {
  return {
    isDesktop: isTauri,
    startWatch: async (paths) => {
      const { invoke } = await import("@tauri-apps/api/core")
      // `plugin_watch_start(app, args: WatchStartArgs)` takes a single struct
      // parameter, so Tauri reads it from the `args` key. The module this
      // replaces sent a flat `{ paths }`, which leaves `args` absent and the
      // command rejects before any watcher is created.
      await invoke("plugin_watch_start", { args: { paths } })
    },
    stopWatch: async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_watch_stop")
    },
    listen: async (event, handler) => {
      const { listen } = await import("@tauri-apps/api/event")
      const { safeUnlisten } = await import("@/lib/tauri/safe-unlisten")
      const off = await listen<PluginFileChangePayload>(event, (e) => handler(e.payload))
      return () => safeUnlisten(off)
    },
    reload: (pluginId, attempt, sessionId) =>
      pluginDevReload({
        schemaVersion: 1,
        sessionId,
        attempt,
        pluginId,
        // The app does not build, so there is no content hash to send. This
        // marks which filesystem change triggered the reload, and it is what
        // the workbench shows in place of a built artifact revision.
        artifactRevision: `local-fs:${Date.now()}`,
        activate: true,
      }),
    record: recordHotReloadEvent,
    now: () => Date.now(),
    debounceMs: DEFAULT_DEBOUNCE_MS,
    sessionId: `app-watch:${Math.random().toString(36).slice(2)}`,
  }
}
