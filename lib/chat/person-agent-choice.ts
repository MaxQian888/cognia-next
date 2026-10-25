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
 * HostState seed); choosing another agent starts a new conversation. Its model
 * is not: a pick from {@link personServedModels} reaches the Host as a
 * `session.model` intent and the next turn runs on it.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { PersonAgentsManifest } from "@/lib/platform/host-feature-manifest"

type SessionChoice = Pick<ChatSession, "agentRuntimeId" | "providerOverride" | "model">

/** Why a turn on this conversation would be refused, as the brain decides it. */
export type PersonAgentProblem =
  | "not-allowed"
  | "execution-unavailable"
  | "no-key"
  | "model-not-served"
  /** Tool-less chat on a model the org serves no key or deployment for. */
  | "chat-model-not-served"

export type PersonConversationAgent =
  | {
      kind: "agent"
      runtimeId: string
      /** `false` when the conversation takes the org default. */
      explicit: boolean
      problem?: PersonAgentProblem
    }
  /** No agent named and no org default: tool-less chat. */
  | { kind: "chat"; problem?: "chat-model-not-served" }

export function personConversationAgent(
  session: SessionChoice,
  agents: PersonAgentsManifest
): PersonConversationAgent {
  const explicit = !!session.agentRuntimeId
  const runtimeId = session.agentRuntimeId ?? agents.defaultAgent ?? undefined
  if (!runtimeId) {
    // The ticket mint refuses a provider or model the org does not serve. An
    // older Host names no chat providers at all, and then nothing is known.
    const known = Object.keys(agents.models).length > 0
    const served =
      !!session.providerOverride &&
      !!session.model &&
      (agents.models[session.providerOverride]?.includes(session.model) ?? false)
    return known && !served ? { kind: "chat", problem: "chat-model-not-served" } : { kind: "chat" }
  }
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

/** One provider the org serves a member's conversation with, and its models. */
export interface PersonServedProvider {
  provider: string
  models: string[]
}

/**
 * The models the org serves this conversation with, by provider, in the
 * Host's order: the agent's own providers for an agent conversation (the
 * lease admits no other), every provider the org holds a key for for
 * tool-less chat (the ticket mint admits any of them). `session` empty means
 * a conversation not yet created, which takes the org default.
 */
export function personServedModels(
  agents: PersonAgentsManifest,
  session: SessionChoice
): PersonServedProvider[] {
  const current = personConversationAgent(session, agents)
  const providers =
    current.kind === "agent"
      ? (agents.allowedAgents.find((entry) => entry.runtimeId === current.runtimeId)?.providers ??
        [])
      : Object.keys(agents.models)
  return providers.flatMap((provider) => {
    const models = agents.models[provider] ?? []
    return models.length > 0 ? [{ provider, models: [...models] }] : []
  })
}

/**
 * The provider and model a member's new conversation starts on: the current
 * pick when the org serves it, else the first model the org serves. `null`
 * when the org serves nothing here, so the caller keeps its own default and
 * the composer says why a turn would be refused.
 */
export function personDefaultModel(
  agents: PersonAgentsManifest,
  current: Pick<ChatSession, "providerOverride" | "model"> = {}
): { providerOverride: string; model: string } | null {
  const served = personServedModels(agents, {})
  if (
    current.providerOverride &&
    current.model &&
    served.some(
      (entry) =>
        entry.provider === current.providerOverride && entry.models.includes(current.model!)
    )
  )
    return { providerOverride: current.providerOverride, model: current.model }
  const first = served[0]
  return first ? { providerOverride: first.provider, model: first.models[0] } : null
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
