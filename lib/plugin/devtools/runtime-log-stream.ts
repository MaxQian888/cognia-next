/**
 * One log stream per plugin, whatever runtime it happens to be.
 *
 * Before this, a plugin author's output lived in two unrelated places with
 * different gates, and two runtimes had none at all:
 *
 *   frontend / hybrid  `debugger.ts` ring, shown only in the Dev Session
 *                      workbench, and only once an activation had been
 *                      verified.
 *   python / hybrid    `lib/plugin/python/log-buffer.ts`, shown only on the
 *                      plugin detail page, a different screen.
 *   wasm               nothing.
 *   vscode-extension   nothing.
 *
 * A Python plugin author watching the workbench saw an empty Runtime Logs
 * card while their real output sat one page away. This module merges the two
 * real sources into one time-ordered stream and names the two gaps rather
 * than leaving them as silence.
 */

import type { PluginType } from "@/types/plugin"
import { getPluginDebugger, type LogEntry } from "./debugger"
import {
  clearPythonLogs,
  getPythonLogs,
  subscribePythonLogs,
  type PythonLogEntry,
} from "@/lib/plugin/python/log-buffer"

export type PluginLogRuntime = "frontend" | "python" | "wasm" | "vscode"
export type PluginLogLevel = "debug" | "info" | "warn" | "error"

export interface PluginRuntimeLogEntry {
  id: string
  pluginId: string
  runtime: PluginLogRuntime
  /**
   * Lifecycle generation as a string, because the two sources disagree: the
   * frontend ring counts, the python host sends an opaque token. `null` means
   * the source did not say.
   */
  generation: string | null
  level: PluginLogLevel
  message: string
  timestamp: number
  /** The python host's frame kind (`progress`, `chunk`, `exit`, …). */
  kind?: string
}

/**
 * Why a runtime contributes nothing, so the UI can say so instead of
 * rendering an empty list that looks like a bug.
 *
 * Both are real gaps, not oversights in this module:
 *   - the WASM host reports failures by throwing, and has no per-plugin
 *     output channel to drain.
 *   - the VS Code extension host lists `window:outputChannelAppend` in
 *     `EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS`, so an extension that
 *     writes to an output channel gets a capability error, not a buffer.
 */
export const RUNTIMES_WITHOUT_LOG_CHANNEL = {
  wasm: "wasm-no-channel",
  "vscode-extension": "vscode-no-channel",
} as const

export type MissingLogChannelReason =
  (typeof RUNTIMES_WITHOUT_LOG_CHANNEL)[keyof typeof RUNTIMES_WITHOUT_LOG_CHANNEL]

/** Every member of `PluginType`, so the switch below cannot silently miss one. */
const PLUGIN_TYPES: PluginType[] = ["frontend", "python", "hybrid", "wasm", "vscode-extension"]

/**
 * Narrow a stored value to a known runtime.
 *
 * `PluginRow.type` is a loose `string` out of Dexie, and the Logs tab decides
 * whether to exist from it. An unrecognised value gets no tab, which is the
 * conservative direction.
 */
export function isPluginType(value: string): value is PluginType {
  return (PLUGIN_TYPES as string[]).includes(value)
}

/** Which sources a plugin type can produce, and why it produces none. Pure. */
export function logSourcesFor(type: PluginType): {
  runtimes: PluginLogRuntime[]
  missingReason?: MissingLogChannelReason
} {
  switch (type) {
    case "frontend":
      return { runtimes: ["frontend"] }
    case "python":
      return { runtimes: ["python"] }
    case "hybrid":
      return { runtimes: ["frontend", "python"] }
    case "wasm":
      return { runtimes: [], missingReason: RUNTIMES_WITHOUT_LOG_CHANNEL.wasm }
    case "vscode-extension":
      return { runtimes: [], missingReason: RUNTIMES_WITHOUT_LOG_CHANNEL["vscode-extension"] }
  }
}

/** Pure. */
export function normalizeFrontendEntry(entry: LogEntry): PluginRuntimeLogEntry {
  return {
    id: entry.id,
    pluginId: entry.pluginId,
    runtime: "frontend",
    generation: String(entry.generation),
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
  }
}

const PYTHON_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"])

/**
 * Pure. Mirrors how the plugin detail Logs tab already reads these frames, so
 * the same event does not read differently on two screens.
 */
export function normalizePythonEntry(entry: PythonLogEntry, index: number): PluginRuntimeLogEntry {
  const data = (entry.data ?? {}) as Record<string, unknown>
  let level: PluginLogLevel = "info"
  let message = ""

  switch (entry.kind) {
    case "log": {
      const declared = typeof data.level === "string" ? data.level.toLowerCase() : ""
      level = PYTHON_LEVELS.has(declared) ? (declared as PluginLogLevel) : "info"
      message = typeof data.line === "string" ? data.line : safeJson(entry.data)
      break
    }
    case "progress": {
      level = "debug"
      const phase = typeof data.phase === "string" ? `[${data.phase}] ` : ""
      const text = typeof data.message === "string" ? data.message : ""
      const pct = typeof data.pct === "number" ? ` (${data.pct}%)` : ""
      message = `${phase}${text}${pct}`.trim() || safeJson(entry.data)
      break
    }
    case "chunk":
      level = "debug"
      message = typeof entry.data === "string" ? entry.data : safeJson(entry.data)
      break
    case "chunk_end":
      level = "debug"
      break
    case "exit":
      level = typeof data.code === "number" && data.code !== 0 ? "error" : "info"
      message = typeof data.code === "number" ? String(data.code) : ""
      break
    default:
      message = safeJson(entry.data)
  }

  return {
    // The python buffer has no id of its own, and two frames can share a
    // millisecond, so the index inside the snapshot keeps keys unique.
    id: `py-${entry.pluginId}-${entry.ts}-${index}`,
    pluginId: entry.pluginId,
    runtime: "python",
    generation: entry.generation ?? null,
    level,
    message,
    timestamp: entry.ts,
    kind: entry.kind,
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

export interface RuntimeLogQuery {
  /**
   * Keep only entries from this lifecycle generation. Compared as a string,
   * so the frontend ring's number and the python host's token both work.
   * Entries whose source reported no generation are kept either way: dropping
   * them would hide a whole runtime rather than filter it.
   */
  generation?: string | number | null
  limit?: number
}

/** Merge both sources for one plugin, oldest first. */
export function getPluginRuntimeLogs(
  pluginId: string,
  query: RuntimeLogQuery = {}
): PluginRuntimeLogEntry[] {
  const merged = [
    ...getPluginDebugger().getLogs(pluginId).map(normalizeFrontendEntry),
    ...getPythonLogs(pluginId).map(normalizePythonEntry),
  ]
  const wanted = query.generation == null ? null : String(query.generation)
  const filtered =
    wanted === null
      ? merged
      : merged.filter((entry) => entry.generation === null || entry.generation === wanted)
  filtered.sort((a, b) => a.timestamp - b.timestamp)
  return query.limit != null ? filtered.slice(-query.limit) : filtered
}

/** Fires whenever either source writes for this plugin. */
export function subscribePluginRuntimeLogs(pluginId: string, onChange: () => void): () => void {
  const offFrontend = getPluginDebugger().onLog((entry) => {
    if (entry.pluginId === pluginId) onChange()
  })
  const offPython = subscribePythonLogs((changedId) => {
    if (changedId === pluginId) onChange()
  })
  return () => {
    offFrontend()
    offPython()
  }
}

export function clearPluginRuntimeLogs(pluginId: string): void {
  getPluginDebugger().clearLogs(pluginId)
  clearPythonLogs(pluginId)
}
