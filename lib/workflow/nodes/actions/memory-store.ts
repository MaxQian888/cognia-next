/**
 * `action.memory.store` — deliberately store one durable fact into the
 * autonomous long-term memory from a workflow. Mirrors the `/remember`
 * explicit-capture path: the text IS the memory (no extraction LLM), but it
 * still flows through the SAME consolidator so it dedupes / updates /
 * supersedes instead of blindly piling up. When no utility LLM client is
 * available the node degrades to a direct Dexie insert + best-effort vector
 * upsert (`consolidated: false`) — the memory is never silently dropped.
 *
 * Trust model: workflow-stored memories default to `system` provenance;
 * `procedural` rules require `provenance: "explicit"` (per
 * types/memory/memory.ts only user/explicit may rewrite agent behavior).
 * PII gate is mandatory — "block" (default, /remember parity) or "redact".
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { MemoryProvenance, MemoryType } from "@/types/memory/memory"

export interface MemoryStoreParams {
  text?: string
  scope?: "global" | "character"
  characterId?: string
  type?: MemoryType
  /** Stable key for procedural dedupe / "always X" overrides. */
  key?: string
  /** 1..10 (default 7, matching /remember's explicit-capture weight). */
  importance?: number
  provenance?: Extract<MemoryProvenance, "explicit" | "system">
  piiGate?: "block" | "redact"
}

export async function runMemoryStore(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const params = ctx.params as MemoryStoreParams
  const rawText = (params.text ?? "").trim()
  if (!rawText) throw nonRetryable("action.memory.store requires a non-empty 'text'")
  const scope = params.scope ?? "global"
  if (scope === "character" && !params.characterId) {
    throw nonRetryable("action.memory.store: 'characterId' is required when scope is 'character'")
  }
  const type: MemoryType = params.type ?? "semantic"
  const provenance = params.provenance ?? "system"
  if (type === "procedural" && provenance !== "explicit") {
    throw nonRetryable(
      "action.memory.store: procedural memories require provenance 'explicit' — " +
        "automated workflows may not silently rewrite agent behavior."
    )
  }

  const [{ getSettings }, { resolveMemoryConfig }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
  ])
  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  if (!config.enabled) {
    throw nonRetryable(
      "action.memory.store: long-term memory is disabled. Enable it in Settings → Memory."
    )
  }
  if (config.temporary) {
    ctx.log("warn", "action.memory.store: temporary mode is on — nothing was saved.")
    return { output: { stored: false, reason: "temporary_mode" } }
  }

  // PII gate — mandatory on the write path (memory text persists durably).
  const { hasNoLeakingPii, redactText } = await import("@/lib/twin/ingest/redact")
  let text = rawText
  let piiRedacted = false
  if ((params.piiGate ?? "block") === "block") {
    if (!hasNoLeakingPii(rawText)) {
      throw nonRetryable(
        "action.memory.store: the text contains PII (email / phone / id / key …) " +
          'and was not saved. Remove it or set piiGate to "redact".'
      )
    }
  } else {
    const result = redactText(rawText)
    text = result.redacted
    piiRedacted = Object.keys(result.map).length > 0
  }

  const candidate = {
    type,
    text,
    importance: clampImportance(params.importance ?? 7),
    ...(params.key ? { key: params.key } : {}),
  }
  const consolidateInput = {
    candidates: [candidate],
    scope,
    characterId: scope === "character" ? params.characterId : undefined,
    provenance,
  }

  // Preferred path: the shared consolidator (dedupe / ADD / UPDATE / DELETE).
  const { buildAutoExtractionDeps } = await import("@/lib/memory/write/run-memory-extraction")
  const deps = await buildAutoExtractionDeps({ session: null, appSettings: settings }, config)
  if (deps) {
    const { applied } = await deps.consolidate(consolidateInput)
    return {
      output: {
        stored: applied.some((op) => op.op !== "NOOP"),
        consolidated: true,
        applied: applied.map((op) => op.op),
        ...(piiRedacted ? { piiRedacted: true } : {}),
      },
    }
  }

  // Degraded path: no utility LLM client → direct insert (BM25-findable) +
  // best-effort vector upsert. The fact still lands; only dedupe is skipped.
  ctx.log(
    "warn",
    "action.memory.store: no utility LLM available — stored without consolidation (dedupe skipped)."
  )
  const [memDb, { tryBuildMemoryVectorSink }] = await Promise.all([
    import("@/lib/db/memories"),
    import("@/lib/memory/runtime/build-deps"),
  ])
  const row = await memDb.createMemory({
    scope,
    characterId: scope === "character" ? params.characterId : undefined,
    type,
    text,
    importance: candidate.importance,
    key: params.key,
    provenance,
  })
  const sink = await tryBuildMemoryVectorSink(config)
  if (sink) {
    try {
      await sink.upsert(row.id, row.text)
      await memDb.updateMemory(row.id, { vectorDocId: row.id })
    } catch {
      // BM25 recall still works without the vector.
    }
  }
  return {
    output: {
      stored: true,
      consolidated: false,
      memoryId: row.id,
      ...(piiRedacted ? { piiRedacted: true } : {}),
    },
  }
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 7
  return Math.min(10, Math.max(1, Math.round(value)))
}

function nonRetryable(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { retryable: boolean }).retryable = false
  return err
}
