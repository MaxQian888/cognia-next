/**
 * Serializers for taking one agent trace out of the app.
 *
 * A trace you can only look at is a trace you cannot escalate. These two
 * formats cover the realistic destinations:
 *
 *  - **JSON** — the raw `AgentTraceSpan[]` exactly as persisted. Round-trips
 *    into a bug report, a fixture, or a script.
 *  - **OTLP** — the same spans through `spansToOtlp`, the converter the
 *    `otlp-http` transport already uses. Drops straight into Jaeger, Tempo,
 *    Honeycomb, or anything else that speaks OTLP/HTTP JSON.
 *
 * Pure: no DOM, no filesystem, no `Date.now()`. The caller supplies the
 * timestamp for filenames so exports stay deterministic under test.
 *
 * Content previews (`inputPreview` / `outputPreview`) travel as persisted —
 * they only exist at all when the user enabled content capture and the
 * redaction gate passed, so re-filtering here would silently disagree with
 * what the UI already showed them. `redactPreviews` is offered for the case
 * where an export leaves the machine and the user wants them stripped anyway.
 */

import { spansToOtlp } from "@cognia/agent-trace/span-to-otlp"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

export type TraceExportFormat = "json" | "otlp"

export const TRACE_EXPORT_FORMATS: readonly TraceExportFormat[] = ["json", "otlp"]

export interface TraceExportOptions {
  /** Drop `inputPreview` / `outputPreview` before serializing. */
  redactPreviews?: boolean
}

const MIME_TYPES: Record<TraceExportFormat, string> = {
  json: "application/json",
  otlp: "application/json",
}

/** MIME type for a format, for `saveExport` and clipboard writes. */
export function traceExportMimeType(format: TraceExportFormat): string {
  return MIME_TYPES[format]
}

function stripPreviews(spans: AgentTraceSpan[]): AgentTraceSpan[] {
  return spans.map((span) => {
    if (span.inputPreview === undefined && span.outputPreview === undefined) return span
    const { inputPreview: _in, outputPreview: _out, ...rest } = span
    return rest as AgentTraceSpan
  })
}

/**
 * Serialize a trace. Spans are emitted chronologically regardless of the
 * order the caller holds them in, so two exports of the same trace are
 * byte-identical.
 */
export function serializeTrace(
  spans: AgentTraceSpan[],
  format: TraceExportFormat,
  options: TraceExportOptions = {}
): string {
  const ordered = [...spans].sort(
    (a, b) => a.startTime - b.startTime || a.spanId.localeCompare(b.spanId)
  )
  const payload = options.redactPreviews ? stripPreviews(ordered) : ordered
  return format === "otlp"
    ? JSON.stringify(spansToOtlp(payload), null, 2)
    : JSON.stringify(payload, null, 2)
}

/**
 * Filename for a trace export. `at` is injected rather than read from the
 * clock so the name is reproducible; the trace id is truncated because a
 * 32-hex id plus a timestamp overflows some file pickers.
 */
export function traceExportFilename(
  traceId: string,
  format: TraceExportFormat,
  at: number
): string {
  const stamp = new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const id = (traceId || "trace").slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, "")
  const suffix = format === "otlp" ? "otlp.json" : "json"
  return `cognia-trace-${id || "trace"}-${stamp}.${suffix}`
}
