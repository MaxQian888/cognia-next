/**
 * `action.memory.store` — deliberately store one durable fact into the
 * autonomous long-term memory from a workflow. Thin adapter over the shared
 * deliberate-write core (`lib/memory/api/store-memory.ts:storeMemoryCore`),
 * which mirrors the `/remember` explicit-capture path: the text IS the memory
 * (no extraction LLM) but still flows through the SAME consolidator so it
 * dedupes / updates / supersedes instead of blindly piling up.
 *
 * Trust model: workflow-stored memories default to `system` provenance;
 * `procedural` rules require `provenance: "explicit"` (per
 * types/memory/memory.ts only user/explicit may rewrite agent behavior).
 * PII gate is mandatory — "block" (default, /remember parity) or "redact"
 * (a workflow-only affordance; external API surfaces are block-only).
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import type { MemoryProvenance, MemoryScope, MemoryType } from "@/types/memory/memory"

export interface MemoryStoreParams {
  text?: string
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
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
  if (scope === "workspace" && !params.projectId) {
    throw nonRetryable("action.memory.store: 'projectId' is required when scope is 'workspace'")
  }
  if (scope === "agent" && !params.agentId) {
    throw nonRetryable("action.memory.store: 'agentId' is required when scope is 'agent'")
  }
  const type: MemoryType = params.type ?? "semantic"
  const provenance = params.provenance ?? "system"
  if (type === "procedural" && provenance !== "explicit") {
    throw nonRetryable(
      "action.memory.store: procedural memories require provenance 'explicit' — " +
        "automated workflows may not silently rewrite agent behavior."
    )
  }

  const { storeMemoryCore } = await import("@/lib/memory/api/store-memory")
  let result
  try {
    result = await storeMemoryCore({
      text: rawText,
      scope,
      characterId: params.characterId,
      projectId: params.projectId,
      agentId: params.agentId,
      branch: params.branch,
      pathPattern: params.pathPattern,
      type,
      key: params.key,
      importance: params.importance,
      provenance,
      piiGate: params.piiGate ?? "block",
    })
  } catch (err) {
    throw nonRetryable(err instanceof Error ? err.message : String(err))
  }

  if (!result.ok) {
    if (result.reason === "disabled") {
      throw nonRetryable(
        "action.memory.store: long-term memory is disabled. Enable it in Settings → Memory."
      )
    }
    if (result.reason === "temporary") {
      ctx.log("warn", "action.memory.store: temporary mode is on — nothing was saved.")
      return { output: { stored: false, reason: "temporary_mode" } }
    }
    throw nonRetryable(
      "action.memory.store: the text contains PII (email / phone / id / key …) " +
        'and was not saved. Remove it or set piiGate to "redact".'
    )
  }

  if (!result.consolidated) {
    ctx.log(
      "warn",
      "action.memory.store: no utility LLM available — stored without consolidation (dedupe skipped)."
    )
    return {
      output: {
        stored: true,
        consolidated: false,
        memoryId: result.memoryId,
        ...(result.piiRedacted ? { piiRedacted: true } : {}),
      },
    }
  }

  return {
    output: {
      stored: result.stored,
      consolidated: true,
      applied: result.applied,
      ...(result.piiRedacted ? { piiRedacted: true } : {}),
    },
  }
}

function nonRetryable(message: string): Error {
  const err = new Error(message)
  ;(err as Error & { retryable: boolean }).retryable = false
  return err
}
