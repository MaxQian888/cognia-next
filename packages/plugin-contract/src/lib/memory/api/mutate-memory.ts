/**
 * The plugin contract's share of `lib/memory/api/mutate-memory.ts`, which re-exports these.
 */
export interface UpdateExternalMemoryPatch {
  text?: string
  importance?: number
  tags?: string[]
  key?: string
  pinned?: boolean
}

export type MutateExternalMemoryResult =
  | { ok: true; version: number }
  | {
      ok: false
      reason:
        | "disabled"
        | "temporary"
        | "pii_blocked"
        | "not_found"
        | "policy_denied"
        | "scope_denied"
        | "unauthorized_namespace"
        | "version_conflict"
        | "idempotency_key_reused"
      /** Present on `version_conflict` — the row's version at commit time. */
      currentVersion?: number
    }
