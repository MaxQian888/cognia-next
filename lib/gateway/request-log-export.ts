/**
 * Export of the gateway request log (Settings → Gateway → Request log).
 *
 * The serializers are pure; `downloadGatewayRequestLog` hands the result to
 * the shared Blob-anchor helper, the same path the gateway config editor's
 * download uses.
 *
 * Several columns are attacker-influenced — the model id and route come from
 * whichever client called the gateway, the error text from the upstream — so
 * a CSV cell that would start a spreadsheet formula is neutralised rather
 * than exported verbatim.
 */

import { downloadFile } from "@/lib/files/download"
import type { GatewayRequestLogRow } from "@/types/gateway"

export type GatewayRequestLogExportFormat = "csv" | "json"

const CSV_COLUMNS = [
  "at",
  "status",
  "latencyMs",
  "route",
  "model",
  "providerId",
  "keyId",
  "remoteIp",
  "inputTokens",
  "outputTokens",
  "stream",
  "synthesized",
  "strategy",
  "selectedDeployment",
  "attempts",
  "fallbackReason",
  "error",
] as const satisfies readonly (keyof GatewayRequestLogRow)[]

/** A leading `= + - @` (or tab / CR) makes Excel and Sheets evaluate the cell. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/

function csvCell(value: unknown): string {
  if (value == null) return ""
  let text: string
  if (Array.isArray(value)) text = String(value.length)
  else text = String(value)
  if (typeof value === "string" && FORMULA_TRIGGER.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** One header row plus one row per request, in the order given. */
export function gatewayRequestLogToCsv(rows: readonly GatewayRequestLogRow[]): string {
  const lines = [CSV_COLUMNS.join(",")]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","))
  }
  return lines.join("\n")
}

/** Every field, attempts included, as pretty-printed JSON. */
export function gatewayRequestLogToJson(rows: readonly GatewayRequestLogRow[]): string {
  return JSON.stringify(rows, null, 2)
}

/** `cognia-gateway-log-20260925-143005.csv`, in local time. */
export function gatewayRequestLogFileName(
  format: GatewayRequestLogExportFormat,
  now: Date
): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `cognia-gateway-log-${stamp}.${format}`
}

export function downloadGatewayRequestLog(
  rows: readonly GatewayRequestLogRow[],
  format: GatewayRequestLogExportFormat,
  now: Date = new Date()
): void {
  const fileName = gatewayRequestLogFileName(format, now)
  if (format === "csv") downloadFile(fileName, gatewayRequestLogToCsv(rows), "text/csv")
  else downloadFile(fileName, gatewayRequestLogToJson(rows), "application/json")
}
