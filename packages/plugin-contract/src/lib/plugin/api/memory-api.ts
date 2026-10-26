/**
 * The plugin contract's share of `lib/plugin/api/memory-api.ts`, which re-exports these.
 */
import type { ExternalMemoryHit } from "../../memory/api/search-memory"
import type { Memory, MemoryScope, MemoryStatus, MemoryType } from "../../../types/memory/memory"
import type {
  MutateExternalMemoryResult,
  UpdateExternalMemoryPatch,
} from "../../memory/api/mutate-memory"
import type { StoreExternalMemoryInput, StoreMemoryCoreResult } from "../../memory/api/store-memory"

export interface PluginMemorySearchOptions {
  /** Defaults to the user's configured `retrievalTopK`. */
  topK?: number
  types?: MemoryType[]
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  path?: string
  /** Default true; false = don't bump lastAccessedAt/accessCount. */
  touch?: boolean
  /**
   * Search memory as it was at this instant (epoch ms): earlier wordings come
   * back from revision history (their `revisionOf` names the memory),
   * memories created later or already forgotten are excluded. Lexical only;
   * never bumps access counters.
   */
  asOf?: number
}

export interface PluginMemoryListFilter {
  type?: MemoryType
  scope?: MemoryScope
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  pathPattern?: string
  /** Defaults to `"active"`; pass `"invalidated"` to inspect history. */
  status?: MemoryStatus
  /** Newest-first cap, default 100. */
  limit?: number
}

export type PluginMemoryStoreInput = Omit<StoreExternalMemoryInput, "source">

/** Long-term memory API exposed to plugins. */
export interface PluginMemoryAPI {
  // --------------------------------------------------------------- reads
  /**
   * Hybrid (BM25 + vector) relevance search over active memories. Degrades to
   * `[]` when memory is disabled, temporary mode is on, or no backend exists.
   */
  search(query: string, opts?: PluginMemorySearchOptions): Promise<ExternalMemoryHit[]>
  /** Newest-first listing (no relevance ranking). Empty when memory is off. */
  list(filter?: PluginMemoryListFilter): Promise<Memory[]>
  /** Fetch one memory by id (undefined when missing or memory is off). */
  get(id: string): Promise<Memory | undefined>
  /** Count of active memories in a scope (0 when memory is off). */
  count(scope?: MemoryScope, characterId?: string): Promise<number>

  // ----------------------------------------------------------- mutations
  /**
   * Store one durable fact (semantic/episodic only). Consolidates against
   * existing memories when a utility LLM is available. Throws `PluginPiiError`
   * when the text trips the PII gate. `input.operationId` makes the write
   * idempotent — a retried identical request replays its first result.
   */
  store(input: PluginMemoryStoreInput): Promise<StoreMemoryCoreResult>
  /**
   * Patch text / importance / tags / key. Text patches are PII-gated.
   * `opts.expectedVersion` is a compare-and-swap guard on the row's version;
   * `opts.operationId` makes a retried identical patch replay its first result.
   */
  update(
    id: string,
    patch: UpdateExternalMemoryPatch,
    opts?: { expectedVersion?: number; operationId?: string }
  ): Promise<MutateExternalMemoryResult>
  /**
   * Soft-invalidate (kept for history; never a hard delete). Same CAS and
   * idempotency options as `update`.
   */
  forget(
    id: string,
    opts?: { expectedVersion?: number; operationId?: string }
  ): Promise<MutateExternalMemoryResult>
}
