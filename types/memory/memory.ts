/**
 * Long-term memory subsystem — canonical types.
 *
 * The memory subsystem is the autonomous, conversation-derived, cross-session
 * store that the Digital Twin / Agent-Team-shared-memory / RAG toolkit never
 * provided: it watches conversations, extracts durable facts about the user,
 * consolidates them (ADD/UPDATE/DELETE/NOOP), and recalls them into later
 * prompts. See `docs/superpowers/specs/2026-06-01-agent-long-term-memory-design.md`.
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
export type MemoryScope = "global" | "character"

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
 */
export type MemoryProvenance = "user" | "explicit" | "inbound" | "system"

export interface Memory {
  /** `mem_<ts>_<rand>`. */
  id: string
  scope: MemoryScope
  /** Set iff `scope === "character"`. */
  characterId?: string
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
}

/**
 * Persisted memory configuration — lives on the `AppSettings` singleton as a
 * JSON blob (no Dexie migration, same pattern as `goalConsoleView`).
 */
export interface MemoryConfig {
  /** Master switch. When false, neither read nor write paths run. */
  enabled: boolean
  /** Background per-turn extraction of semantic/procedural memories. */
  autoExtract: boolean
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
  /** Below this fused-relevance score a memory is not injected. */
  relevanceFloor: number
  /** Eviction cap of active memories per scope. */
  maxActivePerScope: number
  /**
   * Access-time forgetting: invalidate non-pinned memories untouched for longer
   * than this many days (à la Claude's memory tool). 0 disables it (default).
   */
  maxIdleDays?: number
  /** Informational half-life; recency uses an exponential 0.995^Δdays decay. */
  decayHalfLifeDays: number
  /** "Incognito": when true, the current context neither reads nor writes memory. */
  temporary: boolean
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  autoExtract: true,
  scopeDefault: "global",
  hybridEnabled: true,
  allowCloudEmbedding: false,
  retrievalTopK: 8,
  relevanceFloor: 0.35,
  maxActivePerScope: 500,
  maxIdleDays: 0,
  decayHalfLifeDays: 30,
  temporary: false,
}

/** View mode for the `/memory` management panel. */
export type MemoryViewMode = "grid" | "list"

export const MEMORY_TYPES: readonly MemoryType[] = ["semantic", "episodic", "procedural"]

export function isMemoryType(value: unknown): value is MemoryType {
  return value === "semantic" || value === "episodic" || value === "procedural"
}

/** Merge a possibly-partial stored config over the defaults. */
export function resolveMemoryConfig(partial: Partial<MemoryConfig> | undefined): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...(partial ?? {}) }
}
