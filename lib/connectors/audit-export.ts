/**
 * Export helpers for the Settings → Connections → Audit tab.
 *
 * The audit log is the operator's primary observability surface — being
 * able to hand a CSV / JSON to a teammate or paste it into an incident
 * report is a small but consistently-requested affordance. These helpers
 * are pure (CSV / JSON serialisation) plus one tiny DOM helper for the
 * download trigger, so the UI can wire a single onClick without
 * duplicating string-escaping logic.
 *
 * CSV format:
 *   - First row is the header.
 *   - Columns: `at,adapterId,kind,reason,conversationKey,idempotencyKey,message,fields`.
 *   - `fields` is JSON-stringified into a single column so structured
 *     payloads round-trip without us inventing a wide-table layout that
 *     varies per kind.
 *   - Values are RFC-4180-escaped: any cell containing `,`, `"`, or `\n`
 *     is wrapped in `"…"` with embedded `"` doubled.
 *
 * JSON format:
 *   - Pretty-printed array of the rows passed in, verbatim.
 *
 * `downloadBlob` is a thin wrapper around the standard
 * `URL.createObjectURL` + anchor-click + `URL.revokeObjectURL` pattern.
 * Pure dom — no React, no toast — so tests can call it under jsdom.
 */

import type { ConnectorAuditRow } from "@/lib/db/connector-types"

const CSV_COLUMNS = [
  "at",
  "adapterId",
  "kind",
  "reason",
  "conversationKey",
  "idempotencyKey",
  "message",
  "fields",
] as const

type CsvColumn = (typeof CSV_COLUMNS)[number]

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = typeof value === "string" ? value : String(value)
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function pickColumn(row: ConnectorAuditRow, col: CsvColumn): unknown {
  switch (col) {
    case "at":
      return new Date(row.at).toISOString()
    case "adapterId":
      return row.adapterId
    case "kind":
      return row.kind
    case "reason":
      return row.reason ?? ""
    case "conversationKey":
      return row.conversationKey ?? ""
    case "idempotencyKey":
      return row.idempotencyKey ?? ""
    case "message":
      return row.message ?? ""
    case "fields":
      return row.fields ? JSON.stringify(row.fields) : ""
  }
}

/**
 * Serialise audit rows into a CSV string with a leading header row.
 * Safe to hand to a Blob — uses `\n` line endings (Excel handles them on
 * every platform via auto-detection).
 */
export function toCsv(rows: ConnectorAuditRow[]): string {
  const header = CSV_COLUMNS.join(",")
  const body = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvEscape(pickColumn(row, col))).join(",")
  )
  return [header, ...body].join("\n")
}

/** Serialise audit rows as a pretty-printed JSON array. */
export function toJson(rows: ConnectorAuditRow[]): string {
  return JSON.stringify(rows, null, 2)
}

export interface ExportFilenameOptions {
  /** Filter scope — used to compose a hint in the filename. */
  adapterId?: string | null
  format: "csv" | "json"
  /** Override the timestamp for tests; defaults to `Date.now()`. */
  now?: number
}

/**
 * Build a stable filename for the download:
 *   `cognia-audit-<all|adapterId>-<YYYYMMDDHHmm>.<ext>`
 *
 * Uses 4-digit year + 2-digit month/day/hour/minute in **UTC** so files
 * sort lexicographically by capture time regardless of the user's
 * timezone. Operator-facing surfaces should render the in-row timestamp
 * in local time; the filename is purely for sorting.
 */
export function buildExportFilename(options: ExportFilenameOptions): string {
  const d = new Date(options.now ?? Date.now())
  const pad = (n: number) => n.toString().padStart(2, "0")
  const stamp =
    `${d.getUTCFullYear()}` +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  const scope = options.adapterId ? options.adapterId : "all"
  return `cognia-audit-${scope}-${stamp}.${options.format}`
}

/**
 * Trigger a browser download of `blob` named `filename`. Idempotent —
 * the temporary anchor is removed and the object URL revoked
 * synchronously after the click.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.rel = "noopener"
    anchor.style.display = "none"
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface ExportAuditViewOptions {
  rows: ConnectorAuditRow[]
  format: "csv" | "json"
  adapterId?: string | null
  /** Override for the timestamp baked into the filename. */
  now?: number
}

/**
 * Convenience: serialise + filename + trigger download in one call. The
 * UI's "Export" menu just dispatches to this. Pure side-effects on the
 * DOM — no toast / no telemetry inside, so tests stay deterministic.
 */
export function exportAuditView(options: ExportAuditViewOptions): {
  filename: string
  mime: string
} {
  const filename = buildExportFilename({
    adapterId: options.adapterId,
    format: options.format,
    now: options.now,
  })
  const mime = options.format === "csv" ? "text/csv;charset=utf-8" : "application/json"
  const body = options.format === "csv" ? toCsv(options.rows) : toJson(options.rows)
  downloadBlob(filename, new Blob([body], { type: mime }))
  return { filename, mime }
}
