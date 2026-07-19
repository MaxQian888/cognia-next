/**
 * Long-term memory subsystem — canonical types.
 *
 * The memory subsystem is the autonomous, conversation-derived, cross-session
 * store that the Digital Twin / Agent-Team-shared-memory / RAG toolkit never
 * provided: it watches conversations, extracts durable facts about the user,
 * consolidates them (ADD/UPDATE/DELETE/NOOP), and recalls them into later
 * prompts. See ADR-0069 (`docs/content/docs/en/adr/0069-long-term-memory-external-api-surfaces.md`).
 *
 * One `memories` Dexie table (schema v65) carries all three memory types. Rows
 * are never hard-deleted by the consolidation path — contradictions mark a row
 * `invalidated` and link `supersededById`, preserving history (the user can
 * still hard-delete from the panel).
 */

/**
 * LangMem taxonomy:
 *  - `semantic`   — durable user facts/preferences ("I always use pnpm").
 *  - `episodic`   — distilled conversation events ("Decided to use X for Y").
 *  - `procedural` — evolving working instructions injected as guidance
 *    (≈ a product-level CLAUDE.md). Highest injection-risk type — see
 *    `MemoryProvenance` gating.
 */
export type MemoryType = "semantic" | "episodic" | "procedural"

/**
 * `global` memories are shared across every character; `character` memories are
 * an override layer scoped to one character (resolved with global at read time,
 * character wins on key/text collision).
 */
export type MemoryScope = "global" | "workspace" | "character" | "agent"

export type MemoryEvidenceState = "legacy" | "supported"
export type MemoryReviewStatus = "unreviewed" | "verified" | "conflict"
export type MemoryContaminationState = "clean" | "external-context" | "unknown"
export type MemorySensitivity = "normal" | "sensitive"

/**
 * `active` rows are retrievable; `invalidated` rows are soft-deleted (kept for
 * history + temporal reasoning) and excluded from retrieval.
 */
export type MemoryStatus = "active" | "invalidated"

/**
 * Where a memory came from — load-bearing for the trust model. Only `user` /
 * `explicit` provenance may yield `procedural` memories (so an inbound connector
 * message can never silently rewrite the agent's long-term behavior).
 *  - `user`     — auto-extracted from a local, user-authored session.
 *  - `explicit` — the user deliberately captured it (`/remember`, "记住 …").
 *  - `inbound`  — derived from connector-inbound content (third-party). Never
 *    enters global scope; never procedural.
 *  - `system`   — created by the app itself (migrations, seeds).
 *  - `external` — written through an API surface (plugin `ctx.memory`, MCP
 *    bridge tool, companion RPC). Always PII-gated at write; never procedural.
 *    The concrete surface lives in `Memory.sourceChannel`.
 */
export type MemoryProvenance = "user" | "explicit" | "inbound" | "system" | "external"

/** Which API surface wrote an `external`-provenance memory. */
export type MemorySourceChannel = "plugin" | "mcp" | "rpc"

export interface Memory {
  /** `mem_<ts>_<rand>`. */
  id: string
  scope: MemoryScope
  /** Set iff `scope === "character"`. */
  characterId?: string
  /** Owning Project id for workspace-scoped memories and optional narrower layers. */
  projectId?: string
  /** Private namespace. Agent-scoped rows are invisible without the same id. */
  agentId?: string
  /** Optional exact branch restriction. */
  branch?: string
  /** Optional normalized workspace-relative path prefix restriction. */
  pathPattern?: string
  type: MemoryType
  /** Redacted memory content, a single self-contained statement. */
  text: string
  /** Stable key for procedural dedupe / "always X" overrides. */
  key?: string
  tags: string[]

  /** LLM-rated 1..10, set once at write (1 mundane, 10 defining). */
  importance: number
  /** Link to the vector store doc; absent in BM25-only mode. */
  vectorDocId?: string

  createdAt: number
  updatedAt: number
  /** Last time this memory was retrieved — drives the recency factor. */
  lastAccessedAt: number
  accessCount: number
  /** Bumped on every UPDATE. */
  version: number

  status: MemoryStatus
  invalidatedAt?: number
  /** Points at the memory that replaced this one (on DELETE/UPDATE supersession). */
  supersededById?: string

  /** User-pinned → exempt from decay/eviction, never auto-invalidated. */
  pinned: boolean
  provenance: MemoryProvenance
  sourceSessionId?: string
  sourceMessageId?: string
  /** Set on `external` provenance: which API surface wrote it (unindexed). */
  sourceChannel?: MemorySourceChannel
  /** Set when `sourceChannel === "plugin"`: the writing plugin's id (unindexed). */
  sourcePluginId?: string

  /** Undefined on pre-v118 rows is interpreted as `legacy`. */
  evidenceState?: MemoryEvidenceState
  /** Conflicts are retained for review but never injected. */
  reviewStatus?: MemoryReviewStatus
  /** IDs of contradictory rows retained for user review. */
  conflictWithIds?: string[]
  /** Whether the learning turn included external, untrusted context. */
  contaminationState?: MemoryContaminationState
  sensitivity?: MemorySensitivity
}

export interface MemoryReaderContext {
  characterId?: string
  projectId?: string
  agentId?: string
  branch?: string
  path?: string
}

/**
 * Persisted memory configuration — lives on the `AppSettings` singleton as a
 * JSON blob (no Dexie migration, same pattern as `goalConsoleView`).
 */
export interface MemoryConfig {
  /** Master switch. When false, neither read nor write paths run. */
  enabled: boolean
  /** Whether eligible chats may recall saved memories. */
  useMemory: boolean
  /** Whether eligible chats may create or revise learned memories. */
  learnFromChats: boolean
  /** Background per-turn extraction of semantic/procedural memories. */
  autoExtract: boolean
  /** Refuse automatic learning when a turn contains untrusted external context. */
  disableLearningOnExternalContext: boolean
  /** Default scope new auto-extracted memories land in. */
  scopeDefault: MemoryScope
  /** Vector+BM25 hybrid vs BM25-only retrieval. */
  hybridEnabled: boolean
  /**
   * Gate for sending memory text to a cloud embedding provider. Default false →
   * prefer a local embedder; if none is available, fall back to BM25-only so
   * personal facts never leave the machine.
   */
  allowCloudEmbedding: boolean
  /** Max memories injected per turn. */
  retrievalTopK: number
  /** Approximate token budget shared by all learned memories injected per turn. */
  recallTokenBudget: number
  /** Below this fused-relevance score a memory is not injected. */
  relevanceFloor: number
  /** Eviction cap of active memories per scope. */
  maxActivePerScope: number
  /**
   * Access-time forgetting: invalidate non-pinned memories untouched for longer
   * than this many days (à la Claude's memory tool). 0 disables it (default).
   */
  maxIdleDays?: number
  /**
   * Base recency half-life (days) for retrieval scoring — scaled per type by
   * `RECENCY_HALF_LIFE_MULTIPLIER` in `lib/memory/retrieve/scoring.ts` and
   * consumed by the retriever's `recencyHalfLifeDays` input.
   */
  decayHalfLifeDays: number
  /** "Incognito": when true, the current context neither reads nor writes memory. */
  temporary: boolean
  /**
   * Heuristic synonym expansion of the memory BM25 keyword leg (recall lift for
   * alternate phrasings). Off by default; the vector leg is unaffected.
   */
  enableQueryExpansion?: boolean
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  useMemory: true,
  learnFromChats: true,
  autoExtract: true,
  disableLearningOnExternalContext: true,
  scopeDefault: "global",
  hybridEnabled: true,
  allowCloudEmbedding: false,
  retrievalTopK: 8,
  recallTokenBudget: 900,
  relevanceFloor: 0.35,
  maxActivePerScope: 500,
  maxIdleDays: 0,
  decayHalfLifeDays: 30,
  temporary: false,
  enableQueryExpansion: false,
}

/** View mode for the `/memory` management panel. */
export type MemoryViewMode = "grid" | "list"

export const MEMORY_TYPES: readonly MemoryType[] = ["semantic", "episodic", "procedural"]

export function isMemoryType(value: unknown): value is MemoryType {
  return value === "semantic" || value === "episodic" || value === "procedural"
}

/** Merge a possibly-partial stored config over the defaults. */
export function resolveMemoryConfig(partial: Partial<MemoryConfig> | undefined): MemoryConfig {
  const stored = partial ?? {}

  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...stored,
    // `enabled` and `autoExtract` predate the independent per-chat controls.
    // Preserve their old meaning for stored configs that do not have the new keys.
    useMemory: stored.useMemory ?? stored.enabled ?? DEFAULT_MEMORY_CONFIG.useMemory,
    learnFromChats:
      stored.learnFromChats ?? stored.autoExtract ?? DEFAULT_MEMORY_CONFIG.learnFromChats,
  }
}
