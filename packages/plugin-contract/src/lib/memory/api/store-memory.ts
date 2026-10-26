/**
 * The plugin contract's share of `lib/memory/api/store-memory.ts`, which re-exports these.
 */
import type { ConsolidationOp } from "@cognia/memory/consolidate/consolidator"
import type { MemoryScope, MemoryType } from "../../../types/memory/memory"

export type StoreMemoryCoreResult =
  | {
      ok: true
      /** False when the consolidator judged the fact already captured (NOOP). */
      stored: boolean
      consolidated: boolean
      /** The ADDed row's id (absent on UPDATE/NOOP outcomes). */
      memoryId?: string
      applied: ConsolidationOp["op"][]
      piiRedacted?: boolean
    }
  | {
      ok: false
      reason:
        | "disabled"
        | "temporary"
        | "pii_blocked"
        | "policy_denied"
        | "scope_denied"
        | "unauthorized_namespace"
        | "idempotency_key_reused"
    }

export interface StoreExternalMemoryInput {
  text: string
  /** External surfaces may only create semantic/episodic (never procedural). */
  type?: Extract<MemoryType, "semantic" | "episodic">
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  key?: string
  importance?: number
  tags?: string[]
  source?: { sessionId?: string }
  /**
   * Idempotency key, unique per caller principal. A retried store with the
   * same request returns the recorded outcome instead of consolidating a
   * second time; the same key with a DIFFERENT request is refused
   * (`idempotency_key_reused`).
   */
  operationId?: string
}
