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

export {
  DEFAULT_AUTO_ROUTING,
  DEFAULT_DIFFICULTY_ROUTING,
  type AutoRoutingSettings,
  type DifficultyRoutingSettings,
} from "@cognia/provider-types/auto-router"
