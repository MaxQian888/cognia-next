/**
 * Clipboard History — built-in plugin.
 *
 * Maintains an encrypted rolling buffer of clipboard entries inside the
 * plugin's storage namespace (PluginStorageAPI.setSecure / getSecure) so the
 * user doesn't have to manage encryption keys separately. Buffer length,
 * privacy posture and the optional capture poller come from
 * `manifest.configSchema`.
 *
 * Every clipboard read goes through `ctx.clipboard.readText` — the host's
 * permission-guarded (`clipboard:read`) and rate-limited clipboard API. The
 * plugin never opens the OS clipboard itself.
 *
 * Config is read fresh: tools use the per-call `callCtx.config`; the poller and
 * the slash command follow the `onConfigChange` hook, which also restarts the
 * poller so a changed interval or privacy mode applies without a reload.
 *
 * Privacy mode keeps new entries OUT of storage: the most recent one lives in
 * memory only (gone on reload / disable). Entries persisted before privacy
 * mode was switched on stay until `clipboard_history_clear` wipes them.
 *
 * Surfaces:
 *   * agent tool   `clipboard_history_list`        — read the buffer
 *   * agent tool   `clipboard_history_add`         — push an entry explicitly
 *   * agent tool   `clipboard_history_clear`       — wipe the buffer (approval)
 *   * slash command /clipboard-history             — show the buffer in chat
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { ClipboardHistoryCard } from "./clipboard-history-card"

export const manifest = definePluginManifest(manifestJson)

const BUFFER_KEY = "buffer"
const DEFAULT_MAX_ENTRIES = 50
/**
 * Floor for a non-zero poll interval. The host rate-limits `clipboard:read`
 * to a 60-call bucket refilled at one call per second, so a faster poller
 * would drain the bucket and start failing.
 */
export const MIN_POLL_INTERVAL_MS = 1000
/** Entries the slash command prints; the rich card shows the whole buffer. */
const COMMAND_PREVIEW_ENTRIES = 10
const COMMAND_PREVIEW_CHARS = 80

export interface ClipboardEntry {
  text: string
  capturedAt: number
}

export interface ClipboardHistoryConfig {
  maxEntries: number
  privacyMode: boolean
  /** 0 disables automatic capture; otherwise ≥ MIN_POLL_INTERVAL_MS. */
  pollIntervalMs: number
}

/** Normalize a raw config snapshot (schema defaults, bounds, wrong types). */
export function normalizeConfig(raw: Record<string, unknown> | undefined): ClipboardHistoryConfig {
  const cfg = raw ?? {}
  const maxEntries =
    typeof cfg.maxEntries === "number" && Number.isFinite(cfg.maxEntries) && cfg.maxEntries >= 1
      ? Math.floor(cfg.maxEntries)
      : DEFAULT_MAX_ENTRIES
  const interval =
    typeof cfg.pollIntervalMs === "number" && Number.isFinite(cfg.pollIntervalMs)
      ? cfg.pollIntervalMs
      : 0
  return {
    maxEntries,
    privacyMode: cfg.privacyMode === true,
    pollIntervalMs: interval > 0 ? Math.max(Math.round(interval), MIN_POLL_INTERVAL_MS) : 0,
  }
}

/**
 * Wrap untrusted clipboard text as an inline code span so it cannot inject
 * markdown (links, headings, images) into the transcript: the fence is one
 * backtick longer than the longest run inside the text.
 */
export function toCodeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(longestRun + 1)
  return `${fence} ${text} ${fence}`
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > COMMAND_PREVIEW_CHARS ? `${flat.slice(0, COMMAND_PREVIEW_CHARS)}…` : flat
}

const definition = definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger.info("clipboard-history activated")

    let config = normalizeConfig(ctx.config)
    /** Privacy mode's only copy: the latest capture, never written to storage. */
    let memoryLatest: ClipboardEntry | null = null
    let pollHandle: ReturnType<typeof setInterval> | null = null
    /** Last poll failure, so a persistently failing read logs once, not every tick. */
    let lastPollError: string | null = null

    const readBuffer = async (): Promise<ClipboardEntry[]> => {
      const raw = await ctx.storage.getSecure<ClipboardEntry[]>(BUFFER_KEY)
      return Array.isArray(raw) ? raw : []
    }

    /** Persisted entries plus privacy mode's in-memory latest (newest last). */
    const visibleEntries = async (): Promise<ClipboardEntry[]> => {
      const buffer = await readBuffer()
      if (memoryLatest && buffer[buffer.length - 1]?.text !== memoryLatest.text) {
        return [...buffer, memoryLatest]
      }
      return buffer
    }

    /** Record `text`; returns whether it was new and whether it was persisted. */
    const pushIfNew = async (
      cfg: ClipboardHistoryConfig,
      text: string
    ): Promise<{ added: boolean; persisted: boolean }> => {
      if (!text) return { added: false, persisted: false }
      if (cfg.privacyMode) {
        if (memoryLatest?.text === text) return { added: false, persisted: false }
        memoryLatest = { text, capturedAt: Date.now() }
        return { added: true, persisted: false }
      }
      const buffer = await readBuffer()
      if (buffer[buffer.length - 1]?.text === text) return { added: false, persisted: false }
      buffer.push({ text, capturedAt: Date.now() })
      while (buffer.length > cfg.maxEntries) buffer.shift()
      await ctx.storage.setSecure(BUFFER_KEY, buffer)
      return { added: true, persisted: true }
    }

    const stopPolling = () => {
      if (pollHandle) clearInterval(pollHandle)
      pollHandle = null
    }

    const startPolling = () => {
      stopPolling()
      if (config.pollIntervalMs <= 0) return
      pollHandle = setInterval(() => {
        // The interval body runs detached — without the catch a rejected
        // clipboard read/persist would be a silent unhandled rejection.
        void (async () => {
          const text = await ctx.clipboard.readText()
          if (text) await pushIfNew(config, text)
          lastPollError = null
        })().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (message === lastPollError) return
          lastPollError = message
          ctx.logger.warn(`clipboard-history poll failed: ${message}`)
        })
      }, config.pollIntervalMs)
    }
    startPolling()
    ctx.lifecycle.onDispose(stopPolling, "clipboard-history:poll")

    // ADR-0127: rich chat card for `clipboard_history_list` (entries with
    // relative time + per-entry copy) instead of raw JSON.
    ctx.toolResult.registerToolResultRenderer("clipboard_history_list", ClipboardHistoryCard)

    ctx.agent.registerTool(
      definePluginTool({
        name: "clipboard_history_list",
        definition: {
          name: "clipboard_history_list",
          description:
            "Return the recent clipboard history buffer (newest last). In privacy mode only the latest capture is held, in memory.",
          parametersSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        execute: async (_args, callCtx) => {
          const cfg = normalizeConfig(callCtx.config)
          return {
            ok: true as const,
            privacyMode: cfg.privacyMode,
            entries: await visibleEntries(),
          }
        },
      })
    )

    ctx.agent.registerTool(
      definePluginTool({
        name: "clipboard_history_add",
        definition: {
          name: "clipboard_history_add",
          description:
            "Push a clipboard entry into the history buffer explicitly. In privacy mode the entry is kept in memory only.",
          parametersSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
        execute: async (args, callCtx) => {
          const text = typeof args.text === "string" ? args.text : ""
          if (!text) return { ok: false as const, error: "`text` must be a non-empty string." }
          const result = await pushIfNew(normalizeConfig(callCtx.config), text)
          return { ok: true as const, ...result }
        },
      })
    )

    ctx.agent.registerTool(
      definePluginTool({
        name: "clipboard_history_clear",
        definition: {
          name: "clipboard_history_clear",
          description:
            "Permanently empty the clipboard history buffer (persisted entries and the in-memory latest).",
          // Irreversible deletion of the user's saved history.
          requiresApproval: true,
          parametersSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        execute: async () => {
          await ctx.storage.setSecure(BUFFER_KEY, [])
          memoryLatest = null
          return { ok: true as const }
        },
      })
    )

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here; the manager owns registration and teardown.
    return {
      onConfigChange: (next: Record<string, unknown>) => {
        config = normalizeConfig(next)
        startPolling()
      },
      onCommand: async (command: string) => {
        if (command !== "clipboard-history") return false
        const entries = await visibleEntries()
        if (entries.length === 0) {
          return { handled: true, message: ctx.i18n.t("command.empty") }
        }
        const recent = entries.slice(-COMMAND_PREVIEW_ENTRIES).reverse()
        const lines = recent.map(
          (entry, index) =>
            `${index + 1}. ${ctx.i18n.formatRelativeTime(new Date(entry.capturedAt))} — ${toCodeSpan(
              previewText(entry.text)
            )}`
        )
        const header = ctx.i18n.t("command.header", { shown: recent.length, total: entries.length })
        const note = config.privacyMode ? `\n\n${ctx.i18n.t("command.privacyNote")}` : ""
        return { handled: true, message: `${header}\n\n${lines.join("\n")}${note}` }
      },
    }
  },
})

export default definition
