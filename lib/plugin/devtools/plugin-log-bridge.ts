/**
 * Forward a plugin's own runtime output into the unified log pipeline, so
 * `/logs` can show it.
 *
 * The plugin detail pane's Logs section is a LINK into `/logs`
 * (`plugin-logs-link.ts`) filtered to `src=plugin`. Nothing ever satisfied that
 * filter. `getLogSource()` in `components/logging/log-panel.tsx` classifies an
 * entry as the `plugin` source only when it carries `origin`/`runtime` of
 * `"plugin"`, and no emitter in the app set either, so the deep link landed on
 * an empty list for every plugin.
 *
 * The two runtimes are answered in two different places, because their output
 * arrives in two different shapes:
 *
 *   frontend / hybrid  `ctx.logger` is already a unified logger, so it is
 *                      tagged where it is built, in
 *                      `lib/plugin/core/context.ts:createLogger`. Nothing
 *                      needs bridging.
 *   python  / hybrid   NDJSON frames off the host, which reach the renderer as
 *                      bus events rather than as log calls. This module turns
 *                      those into entries.
 *
 * This is the same bridge `lib/mcp/log-bridge.ts` is for MCP servers, and for
 * the same reason: one log surface in the product, reached by tagging entries
 * rather than by building a second list UI. `lib/plugin/python/log-buffer.ts`
 * stays exactly as it is, because the Dev Session workbench reads it live and
 * at a much finer grain than a log panel wants.
 *
 * `wasm` and `vscode-extension` contribute nothing here. That is not an
 * omission: they have no per-plugin output channel at all, which is why
 * `RUNTIMES_WITHOUT_LOG_CHANNEL` names them and the detail pane hides the link
 * for them instead of pointing at a list that can only ever be empty.
 */

import { loggers } from "@cognia/logging"

import { subscribePythonPluginEvents } from "@/lib/plugin/python/event-bus"
import { normalizePythonEntry, type PluginRuntimeLogEntry } from "./runtime-log-stream"

/**
 * Cap on distinct `plugin:<id>` child-logger modules, mirroring the MCP
 * bridge's. Plugin ids come from manifests rather than parsed text, so the set
 * is bounded in practice, but a module registry that only ever grows is worth
 * the same guard in a process that stays up for days.
 */
const MAX_TRACKED_MODULES = 128
const trackedPlugins = new Set<string>()

/** Module suffix used once the cap is reached. */
export const PLUGIN_LOG_OVERFLOW_MODULE = "other"

function moduleName(pluginId: string): string {
  if (trackedPlugins.has(pluginId)) return pluginId
  if (trackedPlugins.size >= MAX_TRACKED_MODULES) return PLUGIN_LOG_OVERFLOW_MODULE
  trackedPlugins.add(pluginId)
  return pluginId
}

/**
 * Write one normalized runtime entry to the unified logger.
 *
 * `runtime`/`origin` are what the panel's source facet keys off. `pluginId`
 * rides in `data` as well as in the module name because the deep link's free
 * text query is the plugin id, and `buildSearchText` reads both.
 */
export function forwardPluginRuntimeLog(entry: PluginRuntimeLogEntry): void {
  const log = loggers.plugin.child(moduleName(entry.pluginId))
  const data = {
    runtime: "plugin",
    origin: "plugin",
    pluginId: entry.pluginId,
    // The plugin's own runtime (frontend / python), which is a different axis
    // from the log `runtime` above. Named apart so neither overwrites the other.
    pluginRuntime: entry.runtime,
    ...(entry.generation === null ? {} : { generation: entry.generation }),
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
  }
  // A python `chunk_end` normalizes to an empty message. Falling back to the
  // frame kind keeps the stream complete instead of writing a blank row.
  const message = entry.message.trim() || (entry.kind ?? entry.runtime)

  switch (entry.level) {
    case "error":
      // CoreLogger.error's signature is (message, error, data).
      log.error(message, undefined, data)
      return
    case "warn":
      log.warn(message, data)
      return
    case "debug":
      log.debug(message, data)
      return
    default:
      log.info(message, data)
  }
}

/**
 * Subscribe the Python runtime for the life of the plugin platform.
 *
 * Idempotent: a second install while one is live is a no-op returning the
 * existing teardown, so a StrictMode remount cannot double every line.
 *
 * The frontend half is deliberately NOT bridged from here. `debugger.ts`'s ring
 * is only written through `createDebugContext`, which the manager installs when
 * `shouldEnablePluginDebug` holds, and that is developer mode AND a non-builtin
 * plugin. Bridging it would have covered nothing in a default install and
 * double-logged every line in a debug session, because the same wrapper also
 * calls the plugin's real logger. That logger is tagged at its source instead
 * (`lib/plugin/core/context.ts:createLogger`), which is one entry per line on
 * every install.
 */
let active: (() => void) | null = null

export function installPluginRuntimeLogBridge(): () => void {
  if (active) return active

  // The python ring's own subscription only names the plugin that changed, so
  // this rides the ingestion bus instead, which carries the frame itself.
  // `appendPythonEvent` dispatches there after buffering, so the two stay in
  // step without a second Tauri listener.
  let sequence = 0
  const offPython = subscribePythonPluginEvents((event) => {
    forwardPluginRuntimeLog(normalizePythonEntry({ ...event, ts: Date.now() }, sequence++))
  })

  const teardown = () => {
    if (active !== teardown) return
    active = null
    offPython()
  }
  active = teardown
  return teardown
}

/** Test seam: forget the module registry and any live subscription. */
export function __resetPluginLogBridgeForTests(): void {
  active?.()
  active = null
  trackedPlugins.clear()
}
