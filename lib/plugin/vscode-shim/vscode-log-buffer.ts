/**
 * Per-extension log for VS Code extensions: what the extension host wrote to
 * stderr (its own and the extension's `console`), and what the extension
 * appended to its output channels.
 *
 * Feeds the plugin runtime log stream (`lib/plugin/devtools/runtime-log-stream.ts`)
 * and, through `installPluginRuntimeLogBridge`'s subscription, the unified
 * logger, so a VS Code extension's output reaches the same two places every
 * other runtime's does.
 */

import type {
  PluginLogLevel,
  PluginRuntimeLogEntry,
} from "@/lib/plugin/devtools/runtime-log-stream"

/** Entries kept per extension; the oldest go first. */
export const VSCODE_LOG_LIMIT = 1_000

const buffers = new Map<string, PluginRuntimeLogEntry[]>()
const listeners = new Set<(pluginId: string) => void>()
const entryListeners = new Set<(entry: PluginRuntimeLogEntry) => void>()
let sequence = 0

/** A stderr line's level, from the prefixes hosts and extensions use. */
export function stderrLevel(line: string): PluginLogLevel {
  // `TypeError: x`, `Error: x`: the colon ends the word, so no trailing `\b`.
  if (/\b(?:ERROR|FATAL|Uncaught)\b|\b\w*Error:/.test(line)) return "error"
  if (/\bWARN(?:ING)?\b/.test(line)) return "warn"
  if (/\bDEBUG\b/.test(line)) return "debug"
  return "info"
}

export function appendVscodeLog(
  pluginId: string,
  entry: { level: PluginLogLevel; message: string; kind: string; generation?: string | null }
): void {
  const record: PluginRuntimeLogEntry = {
    id: `vscode-${pluginId}-${++sequence}`,
    pluginId,
    runtime: "vscode",
    generation: entry.generation ?? null,
    level: entry.level,
    message: entry.message,
    timestamp: Date.now(),
    kind: entry.kind,
  }
  const buffer = buffers.get(pluginId) ?? []
  buffer.push(record)
  if (buffer.length > VSCODE_LOG_LIMIT) buffer.splice(0, buffer.length - VSCODE_LOG_LIMIT)
  buffers.set(pluginId, buffer)
  for (const listener of entryListeners) listener(record)
  for (const listener of listeners) listener(pluginId)
}

export function getVscodeLogs(pluginId: string): PluginRuntimeLogEntry[] {
  return [...(buffers.get(pluginId) ?? [])]
}

export function subscribeVscodeLogs(listener: (pluginId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every new entry, as it is written (the unified-logger bridge). */
export function subscribeVscodeLogEntries(
  listener: (entry: PluginRuntimeLogEntry) => void
): () => void {
  entryListeners.add(listener)
  return () => entryListeners.delete(listener)
}

export function clearVscodeLogs(pluginId: string): void {
  buffers.delete(pluginId)
  for (const listener of listeners) listener(pluginId)
}
