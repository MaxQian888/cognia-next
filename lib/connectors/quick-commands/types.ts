/**
 * Cross-adapter quick-command schema.
 *
 * Previously `LarkQuickCommand` had a `eventKey` field that mapped to the
 * Feishu bot-menu `event_key`. WeCom's interactive cards use `key` for
 * the same role (the button's identity inside a `template_card`). Rather
 * than keep parallel schemas, we generalise to `triggerKey: string` —
 * the platform-specific transport already knows what to do with the
 * string at the wire boundary. The discriminator (which platform/menu
 * this command lives on) is implicit in the adapter that holds the
 * commands list: Lark rows sit on Lark adapter settings, WeCom rows on
 * WeCom adapter settings.
 *
 * Backward-compat for persisted Lark rows that still carry `eventKey`:
 * `normalizeQuickCommand()` accepts either shape and returns a row
 * whose primary key is `triggerKey`. New rows always persist as
 * `triggerKey`. We don't run an explicit Dexie migration — the JSON
 * column shape is opaque to IndexedDB and the runtime read path is the
 * only place that touches it.
 */

export type IMQuickCommandActionType = "prompt" | "slash" | "link"

export interface IMQuickCommandAction {
  type: IMQuickCommandActionType
  /**
   * Prompt text, a slash-command line (e.g. "/agenda today"), or — for
   * `link` — an app-relative path (e.g. "/") resolved against the
   * configured web entry base at reply time. Link commands never run an
   * AI turn; the adapter replies with the resolved URL (plan 2026-07-24
   * P4.2).
   */
  value: string
}

export interface IMQuickCommand {
  /** The platform-side trigger key — Feishu `event_key` / WeCom button `key`. */
  triggerKey: string
  /** Optional human label for the Settings UI. */
  label?: string
  action: IMQuickCommandAction
}

/**
 * Legacy-shape input: pre-im-a2ui Lark rows persisted `eventKey` instead
 * of `triggerKey`. Read-side conversions accept either field and produce
 * a canonical row with `triggerKey`. Write-side always emits `triggerKey`.
 */
export interface LegacyEventKeyQuickCommand {
  eventKey: string
  label?: string
  action: IMQuickCommandAction
}

export function isLegacyEventKeyRow(row: unknown): row is LegacyEventKeyQuickCommand {
  if (!row || typeof row !== "object") return false
  const r = row as Record<string, unknown>
  if (typeof r.eventKey !== "string" || "triggerKey" in r) return false
  const action = r.action as Record<string, unknown> | undefined
  if (!action || typeof action !== "object") return false
  return isQuickCommandActionType(action.type) && typeof action.value === "string"
}

function isQuickCommandActionType(value: unknown): value is IMQuickCommandActionType {
  return value === "prompt" || value === "slash" || value === "link"
}

export function isIMQuickCommand(row: unknown): row is IMQuickCommand {
  if (!row || typeof row !== "object") return false
  const r = row as Record<string, unknown>
  if (typeof r.triggerKey !== "string") return false
  const action = r.action as Record<string, unknown> | undefined
  if (!action || typeof action !== "object") return false
  return isQuickCommandActionType(action.type) && typeof action.value === "string"
}

/**
 * Accept both new (`triggerKey`) and legacy (`eventKey`) shapes; return
 * a canonical `IMQuickCommand` row. Drops malformed rows by returning
 * null — callers filter the result.
 */
export function normalizeQuickCommand(row: unknown): IMQuickCommand | null {
  if (isIMQuickCommand(row)) {
    return {
      triggerKey: row.triggerKey,
      label: row.label,
      action: { type: row.action.type, value: row.action.value },
    }
  }
  if (isLegacyEventKeyRow(row)) {
    return {
      triggerKey: row.eventKey,
      label: row.label,
      action: { type: row.action.type, value: row.action.value },
    }
  }
  return null
}

/**
 * Normalize an unknown input array into a canonical IMQuickCommand list,
 * silently dropping malformed entries. Used by adapter init code where
 * `settings.quickCommands` is a JSON column.
 */
export function normalizeQuickCommandList(input: unknown): IMQuickCommand[] {
  if (!Array.isArray(input)) return []
  const out: IMQuickCommand[] = []
  for (const row of input) {
    const normalized = normalizeQuickCommand(row)
    if (normalized) out.push(normalized)
  }
  return out
}
