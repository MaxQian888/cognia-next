/**
 * Snapshot export for the performance panel. Lets an operator hand a perf
 * capture to a teammate or attach it to an issue. Pure serialisation (JSON /
 * CSV) plus a thin download trigger that reuses `lib/files/download.ts` — no
 * React, no toast — so the helpers are trivial to unit-test under jsdom.
 *
 * Mirrors the shape of `lib/connectors/audit-export.ts` (RFC-4180 escaping,
 * UTC-stamped filename) so the two observability exports stay consistent.
 */

import { downloadFile } from "@/lib/files/download"
import type { PerfSample, ProcessSample, SpanSnapshot } from "./types"

export type PerfExportFormat = "json" | "csv-processes" | "csv-hotspots"

/** RFC-4180 cell escaping: wrap in quotes and double embedded quotes. */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = typeof value === "string" ? value : String(value)
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

const PROCESS_COLUMNS: (keyof ProcessSample)[] = [
  "pid",
  "parentPid",
  "name",
  "role",
  "cpuPct",
  "cpuPctRaw",
  "memBytes",
  "diskReadBps",
  "diskWriteBps",
  "runSecs",
]

const SPAN_COLUMNS: (keyof SpanSnapshot)[] = [
  "name",
  "count",
  "errorCount",
  "avgMs",
  "p50Ms",
  "p95Ms",
  "minMs",
  "maxMs",
  "totalMs",
  "lastTsMs",
]

/** Serialise the process tree of one sample to CSV (leading header row). */
export function processesToCsv(processes: ProcessSample[]): string {
  const header = PROCESS_COLUMNS.join(",")
  const body = processes.map((p) => PROCESS_COLUMNS.map((c) => csvEscape(p[c])).join(","))
  return [header, ...body].join("\n")
}

/** Serialise the span/hotspot rows to CSV (leading header row). */
export function spansToCsv(spans: SpanSnapshot[]): string {
  const header = SPAN_COLUMNS.join(",")
  const body = spans.map((s) => SPAN_COLUMNS.map((c) => csvEscape(s[c])).join(","))
  return [header, ...body].join("\n")
}

/** Serialise the full capture (latest frame + rolling history) as JSON. */
export function snapshotToJson(
  latest: PerfSample | null,
  history: PerfSample[],
  now: number = Date.now()
): string {
  return JSON.stringify(
    {
      exportedAt: new Date(now).toISOString(),
      intervalMs: latest?.intervalMs ?? null,
      sampleCount: history.length,
      latest,
      history,
    },
    null,
    2
  )
}

const KIND: Record<PerfExportFormat, string> = {
  json: "snapshot",
  "csv-processes": "processes",
  "csv-hotspots": "hotspots",
}

/**
 * `cognia-perf-<kind>-<YYYYMMDDHHmm>.<ext>` in UTC so files sort by capture
 * time regardless of timezone.
 */
export function buildPerfExportFilename(
  format: PerfExportFormat,
  now: number = Date.now()
): string {
  const d = new Date(now)
  const pad = (n: number) => n.toString().padStart(2, "0")
  const stamp =
    `${d.getUTCFullYear()}` +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  const ext = format === "json" ? "json" : "csv"
  return `cognia-perf-${KIND[format]}-${stamp}.${ext}`
}

export interface ExportPerfOptions {
  latest: PerfSample | null
  history: PerfSample[]
  format: PerfExportFormat
  /** Override for the timestamp baked into the filename / JSON body (tests). */
  now?: number
}

/**
 * Serialise + name + trigger the browser download in one call. Returns the
 * filename + mime so callers can surface a toast. No-op (returns `null`)
 * outside a DOM context.
 */
export function exportPerfSnapshot(
  options: ExportPerfOptions
): { filename: string; mime: string } | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null
  const { latest, history, format, now } = options
  const filename = buildPerfExportFilename(format, now)
  let body: string
  let mime: string
  if (format === "json") {
    body = snapshotToJson(latest, history, now)
    mime = "application/json"
  } else {
    body =
      format === "csv-processes"
        ? processesToCsv(latest?.processes ?? [])
        : spansToCsv(latest?.topSpans ?? [])
    mime = "text/csv;charset=utf-8"
  }
  downloadFile(filename, body, mime)
  return { filename, mime }
}
