import type { AgentMemoryPolicy } from "@cognia/agent-config-types"
import {
  resolveMemoryTurnPolicy,
  type MemoryExternalContextSource,
  type MemorySessionPolicy,
} from "@/lib/memory/control-plane/policy"
import { resolveMemoryConfig, type MemoryConfig, type MemoryScope } from "@/types/memory/memory"

const ALL_SCOPES: readonly MemoryScope[] = ["global", "workspace", "character", "agent"]

export interface ResolvedAgentMemoryPolicy {
  canRecall: boolean
  canCreate: boolean
  canUpdate: boolean
  canForget: boolean
  canAutoLearn: boolean
  readableScopes: MemoryScope[]
  writableScopes: MemoryScope[]
  recallReason: string
  learnReason: string
}

export function resolveAgentMemoryPolicy(input: {
  config: Partial<MemoryConfig>
  agentPolicy?: AgentMemoryPolicy
  session?: MemorySessionPolicy
  externalContext?: readonly MemoryExternalContextSource[]
}): ResolvedAgentMemoryPolicy {
  const config = resolveMemoryConfig(input.config)
  const operations = input.agentPolicy?.operations ?? {
    recall: true,
    create: true,
    update: true,
    forget: true,
  }
  const readableScopes = [...(input.agentPolicy?.readableScopes ?? ALL_SCOPES)]
  const writableScopes = [...(input.agentPolicy?.writableScopes ?? ALL_SCOPES)]
  const turn = resolveMemoryTurnPolicy({
    config,
    session: input.session,
    externalContext: input.externalContext,
  })
  const globallyWritable = config.enabled && !config.temporary
  const recallRequested = input.session?.memoryUse ?? operations.recall
  const learnRequested = input.session?.memoryLearn ?? input.agentPolicy?.autoLearn ?? true
  const canRecall = turn.canRecall && recallRequested
  const canAutoLearn =
    turn.canLearn &&
    config.autoExtract &&
    learnRequested &&
    operations.create &&
    writableScopes.length > 0

  return {
    canRecall,
    canCreate: globallyWritable && operations.create && writableScopes.length > 0,
    canUpdate: globallyWritable && operations.update && writableScopes.length > 0,
    canForget: config.enabled && operations.forget && writableScopes.length > 0,
    canAutoLearn,
    readableScopes,
    writableScopes,
    recallReason: canRecall
      ? "allowed"
      : input.session?.memoryUse === false
        ? "disabled_for_chat"
        : !recallRequested || !operations.recall
          ? "agent_policy"
          : turn.recallReason,
    learnReason: canAutoLearn
      ? "allowed"
      : input.session?.memoryLearn === false
        ? "disabled_for_chat"
        : !learnRequested || !operations.create
          ? "agent_policy"
          : turn.learnReason,
  }
}

export function scopeAllowedByAgentMemoryPolicy(
  policy: ResolvedAgentMemoryPolicy,
  operation: "recall" | "create" | "update" | "forget",
  scope: MemoryScope
): boolean {
  return operation === "recall"
    ? policy.canRecall && policy.readableScopes.includes(scope)
    : operation === "create"
      ? policy.canCreate && policy.writableScopes.includes(scope)
      : operation === "update"
        ? policy.canUpdate && policy.writableScopes.includes(scope)
        : policy.canForget && policy.writableScopes.includes(scope)
}

export async function resolvePersistedAgentMemoryPolicy(input: {
  config: Partial<MemoryConfig>
  characterId?: string
  sessionId?: string
  externalContext?: readonly MemoryExternalContextSource[]
}): Promise<ResolvedAgentMemoryPolicy> {
  const session = input.sessionId
    ? await import("@/lib/db/sessions")
        .then(({ getSession }) => getSession(input.sessionId!))
        .catch(() => undefined)
    : undefined
  const characterId = input.characterId ?? session?.characterId
  const character = characterId
    ? await import("@/lib/db/characters")
        .then(({ resolveCharacterById }) => resolveCharacterById(characterId))
        .catch(() => undefined)
    : undefined
  return resolveAgentMemoryPolicy({
    config: input.config,
    session,
    agentPolicy: character?.memoryPolicy,
    externalContext: input.externalContext,
  })
}
