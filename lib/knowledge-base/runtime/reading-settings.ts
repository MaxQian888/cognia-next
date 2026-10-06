import type { KnowledgeReadingSettings } from "@cognia/agent-config-types"

export type { KnowledgeReadingSettings }

export const KNOWLEDGE_READING_BOUNDS = {
  topKPerBase: [0, 100],
  ragTokenBudget: [0, 100_000],
  maxCalls: [0, 1_000],
  maxReadChars: [1, 100_000],
  totalReadChars: [0, 1_000_000],
  maxOutlineNodes: [1, 1_000],
  summaryMaxChars: [0, 4_000],
} as const

export const DEFAULT_KNOWLEDGE_READING_SETTINGS: Readonly<KnowledgeReadingSettings> = {
  enabled: false,
  retrievalStrategy: "vector",
  topKPerBase: 5,
  ragTokenBudget: 2_000,
  maxCalls: 32,
  maxReadChars: 16_000,
  totalReadChars: 64_000,
  maxOutlineNodes: 200,
  summaryMaxChars: 500,
}

/** Same precedence as send options: application < character < session. */
export function resolveKnowledgeReadingSettings(
  ...layers: Array<Partial<KnowledgeReadingSettings> | null | undefined>
): KnowledgeReadingSettings {
  const result = { ...DEFAULT_KNOWLEDGE_READING_SETTINGS }
  for (const layer of layers) {
    if (!layer) continue
    if (typeof layer.enabled === "boolean") result.enabled = layer.enabled
    if (["vector", "hybrid", "keyword"].includes(layer.retrievalStrategy ?? ""))
      result.retrievalStrategy = layer.retrievalStrategy!
    for (const key of Object.keys(KNOWLEDGE_READING_BOUNDS) as Array<
      keyof typeof KNOWLEDGE_READING_BOUNDS
    >) {
      const value = layer[key]
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        const [min, max] = KNOWLEDGE_READING_BOUNDS[key]
        result[key] = Math.min(max, Math.max(min, value))
      }
    }
    if (layer.summaryProviderId !== undefined)
      result.summaryProviderId = layer.summaryProviderId.trim().slice(0, 128) || undefined
  }
  return result
}
