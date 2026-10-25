/**
 * An org member's agent choices on a shared Host (P6g, plan §9b.6).
 *
 * The member's person brain declares them on its `host_feature_manifest`
 * (`personAgents`): the agents the org allows, the models the org serves them
 * with, and the member's own month. These functions mirror how that brain
 * resolves a turn (`lib/headless/person-agent/policy.ts`), so the composer can
 * say up front what a turn would be refused for instead of failing it.
 *
 * A conversation's agent is fixed when it is created (`agentRuntimeId` on the
 * HostState seed); choosing another agent starts a new conversation.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { PersonAgentsManifest } from "@/lib/platform/host-feature-manifest"

type SessionChoice = Pick<ChatSession, "agentRuntimeId" | "providerOverride" | "model">

/** Why a turn on this conversation would be refused, as the brain decides it. */
export type PersonAgentProblem =
  "not-allowed" | "execution-unavailable" | "no-key" | "model-not-served"

export type PersonConversationAgent =
  | {
      kind: "agent"
      runtimeId: string
      /** `false` when the conversation takes the org default. */
      explicit: boolean
      problem?: PersonAgentProblem
    }
  /** No agent named and no org default: tool-less chat. */
  | { kind: "chat" }

export function personConversationAgent(
  session: SessionChoice,
  agents: PersonAgentsManifest
): PersonConversationAgent {
  const explicit = !!session.agentRuntimeId
  const runtimeId = session.agentRuntimeId ?? agents.defaultAgent ?? undefined
  if (!runtimeId) return { kind: "chat" }
  const problem = personAgentProblem(agents, runtimeId, session)
  return { kind: "agent", runtimeId, explicit, ...(problem ? { problem } : {}) }
}

function personAgentProblem(
  agents: PersonAgentsManifest,
  runtimeId: string,
  session: SessionChoice
): PersonAgentProblem | undefined {
  const agent = agents.allowedAgents.find((entry) => entry.runtimeId === runtimeId)
  if (!agent) return "not-allowed"
  if (agents.execution !== "sandboxed") return "execution-unavailable"
  if (!agent.available || agent.providers.length === 0) return "no-key"
  const provider = session.providerOverride
  if (!provider || !session.model || !agent.providers.includes(provider)) return "model-not-served"
  // An older Host sends no model list; then only the provider can be checked.
  const served = agents.models[provider]
  if (served && !served.includes(session.model)) return "model-not-served"
  return undefined
}

export interface PersonAgentSeed {
  agentRuntimeId: string
  providerOverride: string
  model: string
}

/**
 * The seed for a new conversation with `runtimeId`. Keeps the current
 * provider and model when the org serves them for that agent, else takes the
 * first model the org serves. `null` when the agent cannot run at all.
 */
export function personAgentSeed(
  agents: PersonAgentsManifest,
  runtimeId: string,
  current: Pick<ChatSession, "providerOverride" | "model"> = {}
): PersonAgentSeed | null {
  const agent = agents.allowedAgents.find((entry) => entry.runtimeId === runtimeId)
  if (!agent || !agent.available || agents.execution !== "sandboxed") return null
  const keeps =
    current.providerOverride &&
    current.model &&
    agent.providers.includes(current.providerOverride) &&
    (agents.models[current.providerOverride]?.includes(current.model) ?? false)
  if (keeps)
    return {
      agentRuntimeId: runtimeId,
      providerOverride: current.providerOverride!,
      model: current.model!,
    }
  for (const provider of agent.providers) {
    const model = agents.models[provider]?.[0]
    if (model) return { agentRuntimeId: runtimeId, providerOverride: provider, model }
  }
  return null
}

export type PersonAllowance =
  /** The Host keeps no usage ledger, or is older than P6g. */
  | { kind: "unknown" }
  | { kind: "unlimited"; spentTokens: number }
  | { kind: "left"; tokens: number; monthlyTokens: number }
  | { kind: "used-up"; monthlyTokens: number }

/** What is left of the member's month; tokens held by running turns count as spent. */
export function personAllowance(agents: PersonAgentsManifest): PersonAllowance {
  const usage = agents.usage
  if (!usage) return { kind: "unknown" }
  if (usage.monthlyTokens === null) return { kind: "unlimited", spentTokens: usage.spentTokens }
  const left = usage.monthlyTokens - usage.spentTokens - usage.reservedTokens
  return left > 0
    ? { kind: "left", tokens: left, monthlyTokens: usage.monthlyTokens }
    : { kind: "used-up", monthlyTokens: usage.monthlyTokens }
}
