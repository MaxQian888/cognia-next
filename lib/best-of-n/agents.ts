import type { BestOfNAgent } from "@/types/best-of-n"
import {
  compareExternalAgentCandidates,
  presetSatisfiesDeclared,
  toExternalAgentCandidate,
  type ExternalAgentCandidateSource,
} from "@/lib/ai/agent/external/config/agent-binding"
import {
  externalAgentIdFromProviderId,
  externalAgentProviderId,
  isExternalAgentProviderId,
} from "@/lib/ai/agent/external/session/session-models"

/** The conversation's own agent, model and provider. */
export const SESSION_AGENT_CHOICE = "session"

/** A saved external-agent configuration, as the external-agent store keeps it. */
export interface BestOfNExternalConfig extends ExternalAgentCandidateSource {
  name: string
}

export interface BestOfNSessionAgent {
  characterId?: string | null
  model?: string | null
  providerOverride?: string | null
}

export interface BestOfNAgentOption {
  /** `session`, or the exact external configuration id. */
  value: string
  kind: "session" | "external"
  /** The configuration's own name; the session option is labelled by the caller. */
  label: string
}

/** Thrown for a name that matches no runnable agent. Nothing is substituted. */
export class BestOfNAgentChoiceError extends Error {
  constructor(readonly choice: string) {
    super(`No enabled agent matches "${choice}"`)
    this.name = "BestOfNAgentChoiceError"
  }
}

function sessionCandidate(session: BestOfNSessionAgent): BestOfNAgent {
  if (!session.characterId) throw new Error("Best-of-N needs a conversation agent")
  return {
    agentId: session.characterId,
    ...(session.model ? { model: session.model } : {}),
    ...(session.providerOverride ? { provider: session.providerOverride } : {}),
  }
}

/** The session agent first, then every enabled external configuration in binding order. */
export function bestOfNAgentOptions(
  configs: readonly BestOfNExternalConfig[],
  externalAgentsAvailable: boolean
): BestOfNAgentOption[] {
  const external = externalAgentsAvailable
    ? configs
        .map((config) => ({ config, candidate: toExternalAgentCandidate(config) }))
        .filter(({ candidate }) => candidate.enabled)
        .sort((a, b) => compareExternalAgentCandidates(a.candidate, b.candidate))
        .map(({ config }) => ({
          value: config.id,
          kind: "external" as const,
          label: config.name || config.id,
        }))
    : []
  return [
    { value: SESSION_AGENT_CHOICE, kind: "session", label: SESSION_AGENT_CHOICE },
    ...external,
  ]
}

/**
 * One choice per candidate. A choice is `session`, an exact external
 * configuration id, or a preset id (`claude-code`, `codex`) that names the
 * first enabled configuration of that runtime in the shared binding order.
 * The conversation's agent remains the identity; an external configuration
 * replaces only the runtime that executes it.
 */
export function resolveBestOfNAgentChoices(
  session: BestOfNSessionAgent,
  choices: readonly string[],
  configs: readonly BestOfNExternalConfig[],
  externalAgentsAvailable: boolean
): BestOfNAgent[] {
  const candidates = configs.map((config) => toExternalAgentCandidate(config))
  return choices.map((raw) => {
    const choice = raw.trim()
    if (choice === SESSION_AGENT_CHOICE) return sessionCandidate(session)
    if (!externalAgentsAvailable) throw new BestOfNAgentChoiceError(choice)
    const exact = candidates.find((candidate) => candidate.id === choice && candidate.enabled)
    // A configuration with its own gateway account is used only when named
    // exactly, the same rule a bare preset binding follows elsewhere.
    const byPreset = candidates
      .filter(
        (candidate) =>
          candidate.enabled &&
          !candidate.gatewayBound &&
          presetSatisfiesDeclared(choice, candidate.presetId)
      )
      .sort(compareExternalAgentCandidates)[0]
    const match = exact ?? byPreset
    if (!match) throw new BestOfNAgentChoiceError(choice)
    return {
      ...sessionCandidate({ characterId: session.characterId }),
      provider: externalAgentProviderId(match.id),
    }
  })
}

/** Split `--agents a,b` (or `--agents=a,b`) off the front of slash arguments. */
export function splitAgentsFlag(args: string): { agents: string[] | null; rest: string } {
  const match = args.trim().match(/^--agents(?:=|\s+)(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return { agents: null, rest: args.trim() }
  const agents = match[1].split(",").map((item) => item.trim())
  return { agents: agents.some((item) => !item) ? [] : agents, rest: (match[2] ?? "").trim() }
}

/** Which runtime a recorded candidate runs on. Legacy unscoped markers are unrunnable. */
export function describeBestOfNAgent(
  agent: BestOfNAgent
): { kind: "external"; configId: string | null } | { kind: "cognia"; agentId: string } {
  if (isExternalAgentProviderId(agent.provider ?? undefined))
    return {
      kind: "external",
      configId: externalAgentIdFromProviderId(agent.provider ?? undefined),
    }
  return { kind: "cognia", agentId: agent.agentId }
}
