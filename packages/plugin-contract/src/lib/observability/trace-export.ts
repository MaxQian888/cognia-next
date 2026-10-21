/**
 * The plugin contract's share of `lib/observability/trace-export.ts`, which re-exports these.
 */
export type TraceExportFormat = "json" | "otlp"

export interface TraceExportOptions {
  /** Drop `inputPreview` / `outputPreview` before serializing. */
  redactPreviews?: boolean
}
