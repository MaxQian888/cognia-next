export interface MemoryAgentNamespaceInput {
  /** External delegation target; must retain its existing isolated namespace. */
  targetAgentId?: string
  twinId?: string
  characterId?: string
}

/** Resolve the one agent-scope namespace used by both recall and learning. */
export function resolveMemoryAgentNamespace(input: MemoryAgentNamespaceInput): string | undefined {
  if (input.targetAgentId?.trim()) return input.targetAgentId
  if (input.twinId?.trim()) return `twin:${input.twinId}`
  return input.characterId?.trim() || undefined
}
