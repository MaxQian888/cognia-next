/**
 * Which agent a member's conversation runs as (P6e).
 *
 * The Host answers `person_agent_policy_get` from the org's live agent policy:
 * the agents the org allows, whether its model credentials cover each one, the
 * org default, and whether this Host can run member agents at all. The answer
 * is read fresh for every turn: an admin who removes an agent or a credential
 * stops the next turn, not the next restart.
 *
 * Resolution, in order:
 *
 * 1. The session's own `agentRuntimeId`, else the org default.
 * 2. Neither: the conversation is tool-less chat (P6c), when the Host offers it.
 * 3. An agent the org does not allow: `org_agent_not_allowed`. A conversation
 *    that named an agent never silently falls back to a different one.
 * 4. Execution unavailable on this Host: `execution_isolation_unavailable`.
 * 5. No org credential covers the agent, or not the conversation's provider:
 *    `model_access_unavailable`.
 */

import type { ChatSession } from "@cognia/agent-config-types"

export interface PersonAllowedAgent {
  runtimeId: string
  /** Whether an org credential covers the agent's model family. */
  available: boolean
  /** Provider ids whose org credential can run this agent. */
  providers: string[]
}

/** The member's own month (P6g). `monthlyTokens: null` means no cap. */
export interface PersonOwnUsage {
  month: string
  spentTokens: number
  reservedTokens: number
  monthlyTokens: number | null
}

export interface PersonAgentPolicy {
  allowedAgents: PersonAllowedAgent[]
  defaultAgent: string | null
  execution: "sandboxed" | "none"
  /**
   * P6g: per provider an allowed agent can use, the models the Host's
   * deployment serves. Empty from a Host older than P6g.
   */
  models: Record<string, string[]>
  /** P6g: null when the Host keeps no usage ledger, or is older than P6g. */
  usage: PersonOwnUsage | null
}

export type PersonAgentResolution =
  | { kind: "agent"; runtimeId: string; provider: string; model: string }
  | { kind: "tool-less" }
  | { kind: "refused"; code: string }

interface PolicyTransport {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function readModels(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const models: Record<string, string[]> = {}
  for (const [provider, ids] of Object.entries(value)) {
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0))
      models[provider] = [...ids]
  }
  return models
}

function readUsage(value: unknown): PersonOwnUsage | null {
  if (!value || typeof value !== "object") return null
  const usage = value as Record<string, unknown>
  if (
    typeof usage.month !== "string" ||
    !isCount(usage.spentTokens) ||
    !isCount(usage.reservedTokens) ||
    !(usage.monthlyTokens === null || isCount(usage.monthlyTokens))
  )
    return null
  return {
    month: usage.month,
    spentTokens: usage.spentTokens,
    reservedTokens: usage.reservedTokens,
    monthlyTokens: usage.monthlyTokens,
  }
}

function isPolicy(
  value: unknown
): value is Omit<PersonAgentPolicy, "models" | "usage"> & Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.allowedAgents) &&
    candidate.allowedAgents.every(
      (agent) =>
        agent !== null &&
        typeof agent === "object" &&
        typeof (agent as PersonAllowedAgent).runtimeId === "string" &&
        typeof (agent as PersonAllowedAgent).available === "boolean" &&
        Array.isArray((agent as PersonAllowedAgent).providers) &&
        (agent as PersonAllowedAgent).providers.every((id) => typeof id === "string")
    ) &&
    (candidate.defaultAgent === null || typeof candidate.defaultAgent === "string") &&
    (candidate.execution === "sandboxed" || candidate.execution === "none")
  )
}

export async function fetchPersonAgentPolicy(
  transport: PolicyTransport
): Promise<PersonAgentPolicy> {
  const policy = await transport.call<unknown>("person_agent_policy_get", {})
  if (!isPolicy(policy))
    throw Object.assign(new Error("person_agent_policy_invalid"), {
      code: "execution_isolation_unavailable",
    })
  // The optional P6g facts degrade to "unknown", never to a refused turn.
  return {
    allowedAgents: policy.allowedAgents.map((agent) => ({
      runtimeId: agent.runtimeId,
      available: agent.available,
      providers: [...agent.providers],
    })),
    defaultAgent: policy.defaultAgent,
    execution: policy.execution,
    models: readModels(policy.models),
    usage: readUsage(policy.usage),
  }
}

export function resolvePersonAgent(
  session: Pick<ChatSession, "agentRuntimeId" | "providerOverride" | "model">,
  policy: PersonAgentPolicy,
  toolLessAvailable: boolean
): PersonAgentResolution {
  const explicit = session.agentRuntimeId
  const runtimeId = explicit ?? policy.defaultAgent ?? undefined
  if (!runtimeId) {
    return toolLessAvailable
      ? { kind: "tool-less" }
      : { kind: "refused", code: "execution_isolation_unavailable" }
  }
  const agent = policy.allowedAgents.find((entry) => entry.runtimeId === runtimeId)
  if (!agent) return { kind: "refused", code: "org_agent_not_allowed" }
  if (policy.execution !== "sandboxed")
    return { kind: "refused", code: "execution_isolation_unavailable" }
  if (!agent.available || agent.providers.length === 0)
    return { kind: "refused", code: "model_access_unavailable" }
  const provider = session.providerOverride
  const model = session.model
  if (!provider || !model || !agent.providers.includes(provider))
    return { kind: "refused", code: "model_access_unavailable" }
  return { kind: "agent", runtimeId, provider, model }
}
