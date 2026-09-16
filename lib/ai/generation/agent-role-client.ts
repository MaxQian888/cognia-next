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
import { resolveAppDefaultModel } from "@/lib/ai/app-default-model"
import {
  isRoutingPlaceholderModel,
  resolveRoleTierModel,
} from "@/lib/ai/routing/auto-model-resolution"

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
  // Provider lane: an app default that belongs to an external agent names a
  // model no configured provider offers (`lib/ai/app-default-model.ts`).
  const appFallback = role === "utility" ? undefined : resolveAppDefaultModel(appSettings).model
  const roleModel = resolveAgentModel(role, agent, appFallback)
  // `"auto"` or an enabled mapping alias is a routing request, not a model id —
  // left in place it would be handed to the provider verbatim. Resolve it
  // through the role's tier rung instead; when no enabled alias resolves, the
  // model drops out and the utility client's own cheap-model chain applies.
  const effectiveModel = override?.model ?? session?.model ?? roleModel
  const isPlaceholder = isRoutingPlaceholderModel(effectiveModel, appSettings?.modelMappings)
  const tier = isPlaceholder ? resolveRoleTierModel({ role, appSettings }) : undefined
  const roleOverride: UtilityModelConfig = {
    ...override,
    providerOverride:
      tier?.providerId ??
      override?.providerOverride ??
      session?.providerOverride ??
      agent?.providerId,
    model: tier ? tier.modelId : isPlaceholder ? undefined : effectiveModel,
  }
  return buildUtilityLlmClient({
    session,
    appSettings,
    override: roleOverride,
    featureId,
  })
}
