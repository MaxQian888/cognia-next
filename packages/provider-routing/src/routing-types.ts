export interface ToolRouteRecord {
  id: string
  kind: "tool" | "plugin"
  refId: string
  pluginId?: string
  utterances: string[]
  embeddings?: number[][]
  embeddingModel?: string
  threshold?: number
  enabled: boolean
  source: "builtin" | "manifest" | "user"
  updatedAt: number
}

export interface SemanticToolRoutingSettings {
  enabled: boolean
  activationToolCount: number
  topK: number
  threshold: number
  pinnedTools: string[]
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

export interface DifficultyRoutingSettings {
  enabled: boolean
  weakModel?: { providerId: string; modelId: string }
  strongModel?: { providerId: string; modelId: string }
  threshold: number
}

export const DEFAULT_DIFFICULTY_ROUTING: DifficultyRoutingSettings = {
  enabled: false,
  threshold: 0.5,
}

export interface AutoRoutingSettings {
  /** Default OFF — the send path is a strict no-op until opted in. */
  enabled: boolean
  /**
   * Difficulty-score (0–1) cut points that map a prompt to a tier alias:
   * `score < balanced` → the low tier, `< powerful` → the mid tier, else the
   * top tier. See `candidateAliases` for the tier list (low → high).
   */
  thresholds: { balanced: number; powerful: number }
  /**
   * Candidate tier aliases ordered low → high capability. The auto-router picks
   * one by difficulty score, then walks toward the nearest enabled alias. These
   * must be aliases present in `modelMappings` for routing to fire.
   */
  candidateAliases: string[]
}

export const DEFAULT_AUTO_ROUTING: AutoRoutingSettings = {
  enabled: false,
  thresholds: { balanced: 0.34, powerful: 0.67 },
  candidateAliases: ["fast", "balanced", "powerful"],
}
