import type {
  AgentModelRole,
  AppSettings,
  Character,
  ChatSession,
  UtilityModelConfig,
} from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { resolveCharacterById } from "@/lib/db/characters"
import { resolveAgentModel } from "@/lib/agent/agent-profile-policy"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"

export interface BuildAgentRoleClientArgs {
  role: AgentModelRole
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  agent?: Character | null
  override?: UtilityModelConfig
  featureId: string
}

/** Resolve a session's Agent before delegating provider/client construction. */
export async function buildAgentRoleLlmClient({
  role,
  session,
  appSettings,
  agent: suppliedAgent,
  override,
  featureId,
}: BuildAgentRoleClientArgs): Promise<LlmClient | null> {
  const agent =
    suppliedAgent ??
    (session?.characterId
      ? await resolveCharacterById(session.characterId).catch(() => undefined)
      : undefined)
  const appFallback = role === "utility" ? undefined : appSettings?.defaultModel
  const roleModel = resolveAgentModel(role, agent, appFallback)
  const roleOverride: UtilityModelConfig = {
    ...override,
    providerOverride: override?.providerOverride ?? session?.providerOverride ?? agent?.providerId,
    model: override?.model ?? session?.model ?? roleModel,
  }
  return buildUtilityLlmClient({
    session,
    appSettings,
    override: roleOverride,
    featureId,
  })
}
