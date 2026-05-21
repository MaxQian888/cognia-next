/**
 * Outbound dead-letter queue export helpers.
 *
 * Mirrors the pattern in `lib/connectors/audit-export.ts`: format a slice
 * of `outboundQueue` rows as CSV or JSON, encode as a Blob, and let the
 * Settings panel hand it off to the browser via `URL.createObjectURL`.
 * No Tauri-specific calls — the desktop wrapper inherits the
 * browser's download flow.
 */

import type { OutboundJobRow } from "@/lib/db/connector-types"

const CSV_FIELDS = [
  "id",
  "adapterId",
  "conversationKey",
  "status",
  "attempts",
  "createdAt",
  "nextAttemptAt",
  "lastError.code",
  "lastError.message",
  "idempotencyKey",
] as const

type CsvField = (typeof CSV_FIELDS)[number]

function escapeCsv(value: unknown): string {
  if (value === undefined || value === null) return ""
  const str = typeof value === "string" ? value : String(value)
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function getField(row: OutboundJobRow, field: CsvField): unknown {
  switch (field) {
    case "id":
      return row.id
    case "adapterId":
      return row.adapterId
    case "conversationKey":
      return row.conversationKey
    case "status":
      return row.status
    case "attempts":
      return row.attempts
    case "createdAt":
      return new Date(row.createdAt).toISOString()
    case "nextAttemptAt":
      return row.nextAttemptAt ? new Date(row.nextAttemptAt).toISOString() : ""
    case "lastError.code":
      return row.lastErrorCode ?? ""
    case "lastError.message":
      return row.lastError ?? ""
    case "idempotencyKey":
      return row.request?.metadata?.idempotencyKey ?? ""
  }
}

/**
 * Render `rows` as a CSV string. The header is the column list above
 * verbatim; values are escaped per RFC 4180 so commas / quotes /
 * newlines inside error messages round-trip safely.
 */
export function dlqRowsToCsv(rows: OutboundJobRow[]): string {
  const header = CSV_FIELDS.join(",")
  const lines = rows.map((row) =>
    CSV_FIELDS.map((field) => escapeCsv(getField(row, field))).join(",")
  )
  return [header, ...lines].join("\n")
}

/**
 * Render `rows` as a stable JSON array. The exporter intentionally
 * forces `null` for missing values (instead of stripping the key) so
 * downstream consumers can rely on the column set being stable across
 * exports.
 */
export function dlqRowsToJson(rows: OutboundJobRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      adapterId: row.adapterId,
      conversationKey: row.conversationKey,
      status: row.status,
      attempts: row.attempts,
      createdAt: new Date(row.createdAt).toISOString(),
      nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt).toISOString() : null,
      lastError: row.lastError ?? null,
      lastErrorCode: row.lastErrorCode ?? null,
      idempotencyKey: row.request?.metadata?.idempotencyKey ?? null,
    })),
    null,
    2
  )
}

export interface DlqDownload {
  filename: string
  blob: Blob
}

export function buildDlqDownload(rows: OutboundJobRow[], format: "csv" | "json"): DlqDownload {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  if (format === "csv") {
    return {
      filename: `dlq-${timestamp}.csv`,
      blob: new Blob([dlqRowsToCsv(rows)], { type: "text/csv;charset=utf-8" }),
    }
  }
  return {
    filename: `dlq-${timestamp}.json`,
    blob: new Blob([dlqRowsToJson(rows)], { type: "application/json;charset=utf-8" }),
  }
}
