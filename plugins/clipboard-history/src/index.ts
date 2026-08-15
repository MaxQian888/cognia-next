/**
 * Clipboard History — built-in plugin.
 *
 * Maintains an encrypted rolling buffer of clipboard entries inside the
 * plugin's storage namespace (PluginStorageAPI.setSecure / getSecure) so the
 * user doesn't have to manage encryption keys separately. Buffer length and
 * privacy posture come from `manifest.configSchema`.
 *
 * Surfaces:
 *   * agent tool   `clipboard_history_list`        — read the buffer
 *   * agent tool   `clipboard_history_add`         — push an entry explicitly
 *   * agent tool   `clipboard_history_clear`       — wipe the buffer
 *   * slash command /clipboard-history             — show the buffer in chat
 */

import { ClipboardHistoryCard } from "./clipboard-history-card"
import type { PluginContext, PluginDefinition } from "@/types/plugin"
import manifestJson from "../plugin.json"
// `isTauri` retained as a fallback for hosts that don't expose
// `ctx.capabilities` (older bootstrap, sidecar harnesses). Prefer
// `ctx.capabilities.tauri` per ADR-0026 §5 §C.
import { isTauri } from "@/lib/tauri"

const BUFFER_KEY = "buffer"

interface ClipboardEntry {
  text: string
  capturedAt: number
}

interface PluginConfig {
  maxEntries?: number
  privacyMode?: boolean
  pollIntervalMs?: number
}

async function readClipboardText(ctx?: PluginContext): Promise<string | null> {
  // Prefer ADR-0026 §5 §C `ctx.capabilities.tauri` when the host wired
  // it; fall back to the direct `isTauri()` import when running under an
  // older bootstrap (the import keeps working as a `@deprecated` path).
  const tauriHost = ctx?.capabilities?.tauri ?? isTauri()
  if (tauriHost) {
    try {
      const mod = await import("@tauri-apps/plugin-clipboard-manager")
      return await mod.readText()
    } catch {
      return null
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return null
    }
  }
  return null
}

async function readBuffer(ctx: PluginContext): Promise<ClipboardEntry[]> {
  const raw = await ctx.storage?.getSecure?.<ClipboardEntry[]>(BUFFER_KEY)
  return Array.isArray(raw) ? raw : []
}

async function writeBuffer(ctx: PluginContext, entries: ClipboardEntry[]): Promise<void> {
  await ctx.storage?.setSecure?.(BUFFER_KEY, entries)
}

function getConfig(ctx: PluginContext): PluginConfig {
  return (ctx.config as PluginConfig | undefined) ?? {}
}

async function pushIfNew(ctx: PluginContext, text: string): Promise<boolean> {
  const cfg = getConfig(ctx)
  if (!text) return false
  if (cfg.privacyMode) return false
  const max = typeof cfg.maxEntries === "number" && cfg.maxEntries > 0 ? cfg.maxEntries : 50
  const buffer = await readBuffer(ctx)
  if (buffer.length > 0 && buffer[buffer.length - 1]?.text === text) {
    return false
  }
  buffer.push({ text, capturedAt: Date.now() })
  while (buffer.length > max) buffer.shift()
  await writeBuffer(ctx, buffer)
  return true
}

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("clipboard-history activated")
    let pollHandle: ReturnType<typeof setInterval> | null = null

    const startPolling = () => {
      const cfg = getConfig(ctx)
      const interval = cfg.pollIntervalMs ?? 0
      if (pollHandle) clearInterval(pollHandle)
      if (cfg.privacyMode || interval <= 0) return
      pollHandle = setInterval(async () => {
        // The interval body runs detached — without this guard a rejected
        // clipboard read/persist becomes a silent unhandled rejection that
        // never surfaces, making poll failures impossible to diagnose.
        try {
          const text = await readClipboardText(ctx)
          if (text) await pushIfNew(ctx, text)
        } catch (err) {
          ctx.logger?.warn?.(
            `clipboard-history poll failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }, interval)
    }
    startPolling()

    // ADR-0127: rich chat card for `clipboard_history_list` (entries with
    // relative time + per-entry copy) instead of raw JSON.
    ctx.toolResult?.registerToolResultRenderer?.("clipboard_history_list", ClipboardHistoryCard)

    ctx.agent?.registerTool?.({
      name: "clipboard_history_list",
      pluginId: ctx.pluginId,
      definition: {
        name: "clipboard_history_list",
        description: "Return the recent clipboard history buffer (newest last).",
        parametersSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      } as never,
      execute: async () => {
        const buffer = await readBuffer(ctx)
        return { ok: true as const, entries: buffer }
      },
    })

    ctx.agent?.registerTool?.({
      name: "clipboard_history_add",
      pluginId: ctx.pluginId,
      definition: {
        name: "clipboard_history_add",
        description: "Push a clipboard entry into the history buffer explicitly.",
        parametersSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      } as never,
      execute: async (args) => {
        const text = (args as { text?: string })?.text ?? ""
        const added = await pushIfNew(ctx, text)
        return { ok: true as const, added }
      },
    })

    ctx.agent?.registerTool?.({
      name: "clipboard_history_clear",
      pluginId: ctx.pluginId,
      definition: {
        name: "clipboard_history_clear",
        description: "Empty the clipboard history buffer.",
        parametersSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      } as never,
      execute: async () => {
        await writeBuffer(ctx, [])
        return { ok: true as const }
      },
    })

    // Save the poll handle on the context so deactivate can clear it.
    ;(
      ctx as { __clipboardHistoryPoll?: ReturnType<typeof setInterval> | null }
    ).__clipboardHistoryPoll = pollHandle
    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "clipboard-history") return false
        const buffer = await readBuffer(ctx)
        const message =
          buffer.length === 0
            ? "Clipboard history is empty."
            : buffer
                .slice(-10)
                .map(
                  (entry, idx) =>
                    `${idx + 1}. ${new Date(entry.capturedAt).toISOString()}: ${
                      entry.text.length > 80 ? entry.text.slice(0, 80) + "…" : entry.text
                    }`
                )
                .join("\n")
        ctx.ui?.showToast?.(message, "info")
        return true
      },
    }
  },
  deactivate: async (ctx?: PluginContext) => {
    const handle = (
      ctx as { __clipboardHistoryPoll?: ReturnType<typeof setInterval> | null } | undefined
    )?.__clipboardHistoryPoll
    if (handle) clearInterval(handle)
  },
}

export default definition
