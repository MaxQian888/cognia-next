// Bridge from imported-message `metadata.usage` to the canonical
// `SessionUsageRow` shape the analytics stack consumes. ADR-0062's adapters
// attach the raw token/cost figures the external transcripts carry onto each
// assistant message's `metadata` (shape below); this module reconstructs the
// per-turn rows so `analyzeSession` / `aggregateByModel` / `aggregateByDay`
// light up for imported conversations without any Dexie round-trip.
//
// Reused by BOTH the CLI stats controller (in-memory, over parsed conversations)
// and `useSessionReport` (falls back to these rows when a session has no live
// `sessionUsage`).
//
// Imported spend was paid in ANOTHER agent, on another machine, often on
// another account. The separation from local spend used to be enforced by
// simply never persisting these rows — which also meant the numbers existed
// only for whoever happened to be looking at a report. Every row now carries
// `surface: "imported"` and `imported: true`, so the separation is a property
// of the data rather than of who reads it: `isLocalSpend` excludes them from
// billing totals and the daily rollup, while a session's own report can still
// show them, labelled.

import type { UsageInfo } from "@/lib/claude/adapter"
import type { StoredMessage } from "@cognia/agent-config-types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

/** What an imported assistant message carries under `metadata`. */
export interface ImportedUsageMeta {
  usage: UsageInfo
  /** Per-turn model id when the source reports it per message. */
  model?: string
}

/** The minimal message shape the bridge reads (StoredMessage & the hook rows both satisfy it). */
export interface ImportedMessageLike {
  id: string
  sessionId?: string
  role: string
  createdAt?: number
  metadata?: StoredMessage["metadata"]
}

/**
 * Build the `metadata` blob an imported assistant message carries. `model` is
 * omitted when unknown so the row falls back to the session-level model.
 */
export function importedUsageMetadata(usage: UsageInfo, model?: string): StoredMessage["metadata"] {
  return { usage, ...(model ? { model } : {}) }
}

function readUsage(meta: StoredMessage["metadata"]): UsageInfo | null {
  if (!meta || typeof meta !== "object") return null
  const usage = (meta as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object") return null
  return usage as UsageInfo
}

function readModel(meta: StoredMessage["metadata"]): string | undefined {
  const model = meta && typeof meta === "object" ? (meta as { model?: unknown }).model : undefined
  return typeof model === "string" && model ? model : undefined
}

/**
 * Reconstruct per-turn {@link SessionUsageRow}s from imported messages'
 * `metadata.usage`. Only assistant messages carrying a usage blob yield a row.
 * `at` = message `createdAt`; the model prefers the per-message `metadata.model`,
 * else the `fallbackModel` (session model). Rows preserve message order.
 */
export function deriveImportedUsageRows(
  messages: readonly ImportedMessageLike[],
  opts: { fallbackModel?: string } = {}
): SessionUsageRow[] {
  const rows: SessionUsageRow[] = []
  for (const m of messages) {
    if (m.role !== "assistant") continue
    const usage = readUsage(m.metadata)
    if (!usage) continue
    rows.push({
      messageId: m.id,
      sessionId: m.sessionId ?? "",
      at: m.createdAt ?? 0,
      model: readModel(m.metadata) ?? opts.fallbackModel,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
      cacheReadTokens: usage.cacheReadInputTokens ?? 0,
      costUsd: usage.totalCostUsd ?? 0,
      durationMs: usage.durationMs ?? 0,
      surface: "imported",
      imported: true,
      // The source transcript reported this figure; we did not price it. Saying
      // so is what stops a later reader from re-pricing it at OUR rates.
      costSource: usage.totalCostUsd !== undefined ? "sdk" : "unknown",
      costKnown: usage.totalCostUsd !== undefined,
    })
  }
  return rows
}

/** True when any message carries an imported usage blob (cheap pre-check). */
export function hasImportedUsage(messages: readonly ImportedMessageLike[]): boolean {
  return messages.some((m) => m.role === "assistant" && readUsage(m.metadata) !== null)
}
