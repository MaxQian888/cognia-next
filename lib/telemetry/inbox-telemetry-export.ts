/**
 * Export helpers for `inboxTelemetryEvents` rows.
 *
 * Mirrors the shape of `lib/connectors/audit-export.ts` but with a
 * row-specific column layout. Kept in a separate module so the connector
 * audit exporter stays scoped to `ConnectorAuditRow` and the telemetry
 * exporter can evolve its columns (kind / fields shape) independently.
 *
 * Reuses `downloadBlob` from the audit exporter — the DOM glue is fully
 * generic and there's no point in duplicating it.
 */

import type { InboxTelemetryEventRow } from "@/lib/db/inbox-telemetry-types"
import { downloadBlob } from "@/lib/connectors/audit-export"

const CSV_COLUMNS = ["at", "kind", "adapterId", "conversationKey", "fields"] as const

type CsvColumn = (typeof CSV_COLUMNS)[number]

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = typeof value === "string" ? value : String(value)
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function pickColumn(row: InboxTelemetryEventRow, col: CsvColumn): unknown {
  switch (col) {
    case "at":
      return new Date(row.at).toISOString()
    case "kind":
      return row.kind
    case "adapterId":
      return row.adapterId ?? ""
    case "conversationKey":
      return row.conversationKey ?? ""
    case "fields":
      return row.fields ? JSON.stringify(row.fields) : ""
  }
}

/** Serialise telemetry rows into a CSV string with a leading header row. */
export function toCsv(rows: InboxTelemetryEventRow[]): string {
  const header = CSV_COLUMNS.join(",")
  const body = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvEscape(pickColumn(row, col))).join(",")
  )
  return [header, ...body].join("\n")
}

/** Serialise telemetry rows as a pretty-printed JSON array. */
export function toJson(rows: InboxTelemetryEventRow[]): string {
  return JSON.stringify(rows, null, 2)
}

export interface ExportFilenameOptions {
  format: "csv" | "json"
  /** Override the timestamp for tests; defaults to `Date.now()`. */
  now?: number
}

/**
 * Build a stable filename like `cognia-inbox-telemetry-<YYYYMMDDHHmm>.csv`.
 * Uses UTC for sortability regardless of the operator's locale.
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
  return `cognia-inbox-telemetry-${stamp}.${options.format}`
}

export interface ExportInboxTelemetryOptions {
  rows: InboxTelemetryEventRow[]
  format: "csv" | "json"
  /** Override for the timestamp baked into the filename. */
  now?: number
}

/**
 * Convenience: serialise + filename + trigger download in one call.
 * Returns the resolved filename + MIME so callers can render a toast or
 * write a follow-up audit row.
 */
export function exportInboxTelemetry(options: ExportInboxTelemetryOptions): {
  filename: string
  mime: string
} {
  const filename = buildExportFilename({ format: options.format, now: options.now })
  const mime = options.format === "csv" ? "text/csv;charset=utf-8" : "application/json"
  const body = options.format === "csv" ? toCsv(options.rows) : toJson(options.rows)
  downloadBlob(filename, new Blob([body], { type: mime }))
  return { filename, mime }
}
