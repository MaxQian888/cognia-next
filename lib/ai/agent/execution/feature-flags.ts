// Feature flags for the unified Agent execution rollout (ADR-0090, Phase 0).
//
// Precedence mirrors lib/canvas/feature-flags.ts: defaults (all OFF) <
// NEXT_PUBLIC_* env < localStorage. When `window` is absent (headless brain,
// node tests) only env applies, so the same module serves both hosts.

export type AgentExecutionFlag =
  | "agentExecutionResolverV2"
  | "genericAgentHostCommands"
  | "gatewayAgentRouteTickets"
  | "headlessLlmGateway"
  | "experimentalAnthropicDeploymentAgentSdk"

const AGENT_EXECUTION_FLAGS_KEY = "cognia-agent-execution-flags-v1"

export const AGENT_EXECUTION_FLAGS: readonly AgentExecutionFlag[] = [
  "agentExecutionResolverV2",
  "genericAgentHostCommands",
  "gatewayAgentRouteTickets",
  "headlessLlmGateway",
  "experimentalAnthropicDeploymentAgentSdk",
]

const DEFAULT_AGENT_EXECUTION_FLAGS: Record<AgentExecutionFlag, boolean> = {
  agentExecutionResolverV2: false,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
}

function parseFlagValue(raw: string | undefined): boolean | undefined {
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  return undefined
}

function readEnvFlags(): Partial<Record<AgentExecutionFlag, boolean>> {
  // Each env var is referenced statically so Next.js can inline it into the
  // client bundle; read per-call so node/headless env changes are observed.
  const raw: Record<AgentExecutionFlag, string | undefined> = {
    agentExecutionResolverV2: process.env.NEXT_PUBLIC_AGENT_EXECUTION_RESOLVER_V2,
    genericAgentHostCommands: process.env.NEXT_PUBLIC_GENERIC_AGENT_HOST_COMMANDS,
    gatewayAgentRouteTickets: process.env.NEXT_PUBLIC_GATEWAY_AGENT_ROUTE_TICKETS,
    headlessLlmGateway: process.env.NEXT_PUBLIC_HEADLESS_LLM_GATEWAY,
    experimentalAnthropicDeploymentAgentSdk:
      process.env.NEXT_PUBLIC_EXPERIMENTAL_ANTHROPIC_DEPLOYMENT_AGENT_SDK,
  }
  const result: Partial<Record<AgentExecutionFlag, boolean>> = {}
  for (const flag of AGENT_EXECUTION_FLAGS) {
    const parsed = parseFlagValue(raw[flag])
    if (parsed !== undefined) result[flag] = parsed
  }
  return result
}

function readStoredFlags(): Partial<Record<AgentExecutionFlag, boolean>> {
  if (typeof window === "undefined") {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(AGENT_EXECUTION_FLAGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<Record<AgentExecutionFlag, unknown>>
    const result: Partial<Record<AgentExecutionFlag, boolean>> = {}
    for (const flag of AGENT_EXECUTION_FLAGS) {
      if (typeof parsed[flag] === "boolean") result[flag] = parsed[flag]
    }
    return result
  } catch {
    return {}
  }
}

export function getAgentExecutionFlags(): Record<AgentExecutionFlag, boolean> {
  return {
    ...DEFAULT_AGENT_EXECUTION_FLAGS,
    ...readEnvFlags(),
    ...readStoredFlags(),
  }
}

export function isAgentExecutionFlagEnabled(flag: AgentExecutionFlag): boolean {
  return getAgentExecutionFlags()[flag]
}
