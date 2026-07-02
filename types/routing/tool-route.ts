/**
 * Semantic tool-routing data model (semantic-router analog).
 *
 * A route attaches example utterances to a tool (or a whole plugin); the
 * matcher embeds the user's query, scores each candidate tool by max
 * cosine similarity against its utterance vectors, and — when semantic
 * tool routing is enabled and the exposed plugin-tool count exceeds the
 * activation threshold — prunes `opts.pluginTools` to the top-K matches
 * plus pinned tools. Built-in tools are NEVER pruned.
 */

/** One persisted route (Dexie `toolRoutes`, schema v76). */
export interface ToolRouteRecord {
  /** Primary key — `${source}:${kind}:${refId}` by convention. */
  id: string
  /** What the route targets: a single tool name or every tool of a plugin. */
  kind: "tool" | "plugin"
  /** Tool name (manifest entry name) or pluginId. */
  refId: string
  /** Owning plugin for `source: "manifest"` rows (disable cleanup). */
  pluginId?: string
  /** Example phrasings that should route to this tool. */
  utterances: string[]
  /** Cached utterance vectors (regenerated when the model changes). */
  embeddings?: number[][]
  /** Embedding model the cached vectors were produced with. */
  embeddingModel?: string
  /** Per-route similarity floor; absent → the global settings threshold. */
  threshold?: number
  enabled: boolean
  source: "builtin" | "manifest" | "user"
  updatedAt: number
}

/** Settings block: opt-in semantic pruning of exposed plugin tools. */
export interface SemanticToolRoutingSettings {
  /** Default OFF — pruning never changes behavior until opted in. */
  enabled: boolean
  /** Only prune when more plugin tools than this are exposed. */
  activationToolCount: number
  /** How many tools survive pruning (pins ride on top). */
  topK: number
  /** Global cosine-similarity floor. */
  threshold: number
  /** Tool names that always survive pruning. */
  pinnedTools: string[]
  /**
   * Embedding engine for the matcher. Defaults to the local
   * transformers.js MiniLM (no API key, fully offline).
   */
  embedding?: {
    provider: string
    model: string
    dimensions?: number
  }
}

export const DEFAULT_SEMANTIC_TOOL_ROUTING: SemanticToolRoutingSettings = {
  enabled: false,
  activationToolCount: 24,
  topK: 12,
  threshold: 0.35,
  pinnedTools: [],
}

/** Settings block: opt-in heuristic strong/weak difficulty routing. */
export interface DifficultyRoutingSettings {
  /** Default OFF. */
  enabled: boolean
  /** Cheap model for low-difficulty prompts. */
  weakModel?: { providerId: string; modelId: string }
  /** Capable model for high-difficulty prompts. */
  strongModel?: { providerId: string; modelId: string }
  /** Difficulty score (0–1) at or above which the strong model is used. */
  threshold: number
}

export const DEFAULT_DIFFICULTY_ROUTING: DifficultyRoutingSettings = {
  enabled: false,
  threshold: 0.5,
}

/**
 * Settings block: opt-in automatic tier routing (default OFF). When enabled,
 * `resolveSendOptions` scores each outgoing prompt's difficulty and rewrites a
 * non-alias model to one of `candidateAliases`, which the existing alias engine
 * then resolves. A strict no-op until opted in and until matching aliases exist
 * in `modelMappings`. See `lib/routing/auto-tier.ts`.
 */
export interface AutoRoutingSettings {
  /** Default OFF — the send path is a strict no-op until opted in. */
  enabled: boolean
  /**
   * Difficulty-score (0–1) cut points: `score < balanced` → the low tier,
   * `< powerful` → the mid tier, else the top tier (see `candidateAliases`).
   */
  thresholds: { balanced: number; powerful: number }
  /** Candidate tier aliases ordered low → high capability. */
  candidateAliases: string[]
}

export const DEFAULT_AUTO_ROUTING: AutoRoutingSettings = {
  enabled: false,
  thresholds: { balanced: 0.34, powerful: 0.67 },
  candidateAliases: ["fast", "balanced", "powerful"],
}
