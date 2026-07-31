/**
 * CSV serialization for the observability dashboard's exportable tables.
 *
 * Pure, side-effect-free (no Blob/DOM) so it unit-tests cleanly; the actual
 * cross-platform file write is done by `lib/files/save-export.ts:saveExport`.
 * Values are RFC-4180 escaped: a field is double-quoted when it contains a
 * comma, quote, CR or LF, and inner quotes are doubled.
 */

import type { TraceRollupRow } from "./trace-rollup"
import type { BreakdownRow } from "./breakdown"

/** Quote + escape one field per RFC 4180. */
export function csvField(value: string | number): string {
  const s = String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Join a matrix of rows (already stringified cells) into a CRLF-delimited CSV. */
export function csvRows(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n")
}

const TRACE_HEADER = [
  "traceId",
  "rootName",
  "startTime",
  "durationMs",
  "spanCount",
  "errorCount",
  "totalCostUsd",
  "surface",
] as const

/** Serialize the recent-traces table to CSV (one row per trace). `startTime`
 * is emitted as an ISO-8601 string so spreadsheets parse it as a date. */
export function tracesToCsv(rows: TraceRollupRow[]): string {
  const body: (string | number)[][] = rows.map((r) => [
    r.traceId,
    r.rootName,
    new Date(r.startTime).toISOString(),
    r.durationMs,
    r.spanCount,
    r.errorCount,
    r.totalCostUsd,
    r.surface,
  ])
  return csvRows([[...TRACE_HEADER], ...body])
}

const BREAKDOWN_HEADER = [
  "key",
  "spans",
  "costUsd",
  "inputTokens",
  "outputTokens",
  "errors",
  "avgLatencyMs",
] as const

/** Serialize a breakdown table (by model / surface / …) to CSV. */
export function breakdownToCsv(rows: BreakdownRow[]): string {
  const body: (string | number)[][] = rows.map((r) => [
    r.key,
    r.spans,
    r.costUsd,
    r.inputTokens,
    r.outputTokens,
    r.errors,
    r.avgLatencyMs,
  ])
  return csvRows([[...BREAKDOWN_HEADER], ...body])
}
