import { resolveMemoryConfig, type MemoryConfig } from "../types/memory"

export type MemoryExternalContextSource =
  "web-search" | "mcp" | "tool-search" | "screen" | "connector" | "document" | "local-tool" | "file"

export type MemoryPolicyReason =
  "allowed" | "disabled" | "disabled_for_chat" | "temporary" | "external_context"

export interface MemorySessionPolicy {
  memoryUse?: boolean
  memoryLearn?: boolean
}

export interface ResolveMemoryTurnPolicyInput {
  config: Partial<MemoryConfig>
  session?: MemorySessionPolicy
  externalContext?: readonly MemoryExternalContextSource[]
}

export interface MemoryTurnPolicy {
  canRecall: boolean
  canLearn: boolean
  recallReason: MemoryPolicyReason
  learnReason: MemoryPolicyReason
}

const LOCAL_CONTEXT_SOURCES = new Set<MemoryExternalContextSource>(["local-tool", "file"])

export function hasUntrustedMemoryContext(
  externalContext: readonly MemoryExternalContextSource[]
): boolean {
  return externalContext.some((source) => !LOCAL_CONTEXT_SOURCES.has(source))
}

/** Resolve all memory read/write gates once at the start of a turn. */
export function resolveMemoryTurnPolicy({
  config: partialConfig,
  session,
  externalContext = [],
}: ResolveMemoryTurnPolicyInput): MemoryTurnPolicy {
  const config = resolveMemoryConfig(partialConfig)

  if (config.temporary) {
    return {
      canRecall: false,
      canLearn: false,
      recallReason: "temporary",
      learnReason: "temporary",
    }
  }

  if (!config.enabled) {
    return {
      canRecall: false,
      canLearn: false,
      recallReason: "disabled",
      learnReason: "disabled",
    }
  }

  const canRecall = session?.memoryUse ?? config.useMemory
  const requestedLearning = session?.memoryLearn ?? config.learnFromChats
  const containsExternalContext = hasUntrustedMemoryContext(externalContext)
  const canLearn =
    requestedLearning && !(config.disableLearningOnExternalContext && containsExternalContext)

  return {
    canRecall,
    canLearn,
    recallReason: canRecall ? "allowed" : "disabled_for_chat",
    learnReason: canLearn
      ? "allowed"
      : requestedLearning
        ? "external_context"
        : "disabled_for_chat",
  }
}
