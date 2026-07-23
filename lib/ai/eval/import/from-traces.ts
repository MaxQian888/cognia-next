/**
 * Bulk-import the app's own production traces as eval cases. Reuses the pure
 * {@link TraceSummary} shape (caller supplies summaries from
 * `summarizeTraces(queryRecent())`), so this stays Dexie-free and testable.
 * Each selected trace becomes a `real-trace` case carrying `sourceTraceId`.
 */

import type { EvalCase } from "@/types/eval/eval"
import type { ImportPreview } from "@/types/eval/import"
import type { TraceSummary } from "../trace-summary"
import type { MappingDeps } from "./field-mapping"

export interface TraceImportFilter {
  /** Only traces invoking at least one of these tools. */
  toolNames?: string[]
  /** Only traces at/after this epoch ms. */
  since?: number
  /** Only traces at/before this epoch ms. */
  until?: number
  /** Restrict to these trace ids (e.g. a UI multi-select). */
  traceIds?: string[]
}

function matches(summary: TraceSummary, filter?: TraceImportFilter): boolean {
  if (!filter) return true
  if (filter.traceIds && !filter.traceIds.includes(summary.traceId)) return false
  if (typeof filter.since === "number" && summary.startTime < filter.since) return false
  if (typeof filter.until === "number" && summary.startTime > filter.until) return false
  if (filter.toolNames && filter.toolNames.length > 0) {
    const set = new Set(summary.toolNames)
    if (!filter.toolNames.some((t) => set.has(t))) return false
  }
  return true
}

export interface TraceImportOptions {
  /**
   * traceId → the ORIGINAL user prompt, from
   * `lib/ai/eval/trace-prompt.ts:resolveTracePrompts`. A summary's `preview` is
   * a truncated, PII-gated span field; using it as the case input meant every
   * case built from real traffic was a clipped fragment of the real request.
   * Falls back to the preview when a prompt cannot be recovered.
   */
  prompts?: Record<string, string>
}

export function tracesToCases(
  summaries: TraceSummary[],
  deps: MappingDeps,
  filter?: TraceImportFilter,
  options: TraceImportOptions = {}
): ImportPreview {
  const cases: EvalCase[] = []
  const skipped: { row: number; reason: string }[] = []
  summaries.forEach((summary, index) => {
    if (!matches(summary, filter)) return
    const input = options.prompts?.[summary.traceId] || summary.preview || summary.traceId
    if (!input.trim()) {
      skipped.push({ row: index, reason: "empty trace preview" })
      return
    }
    const ts = deps.now()
    cases.push({
      id: deps.id(),
      datasetId: deps.datasetId,
      input,
      capability: deps.capability,
      source: "real-trace",
      sourceTraceId: summary.traceId,
      createdAt: ts,
      updatedAt: ts,
      ...(summary.toolNames.length > 0 ? { reference: { expectedTools: summary.toolNames } } : {}),
    })
  })
  return { cases, skipped }
}
