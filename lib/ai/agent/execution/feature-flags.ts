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
  | "claudeSdkParityV1"
  | "claudeSdkSessionStore"
  | "claudeSdkCheckpoint"
  | "claudeSdkPrewarm"

const AGENT_EXECUTION_FLAGS_KEY = "cognia-agent-execution-flags-v1"

export const AGENT_EXECUTION_FLAGS: readonly AgentExecutionFlag[] = [
  "agentExecutionResolverV2",
  "genericAgentHostCommands",
  "gatewayAgentRouteTickets",
  "headlessLlmGateway",
  "experimentalAnthropicDeploymentAgentSdk",
  "claudeSdkParityV1",
  "claudeSdkSessionStore",
  "claudeSdkCheckpoint",
  "claudeSdkPrewarm",
]

const DEFAULT_AGENT_EXECUTION_FLAGS: Record<AgentExecutionFlag, boolean> = {
  agentExecutionResolverV2: false,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
  claudeSdkParityV1: false,
  claudeSdkSessionStore: false,
  claudeSdkCheckpoint: false,
  claudeSdkPrewarm: false,
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
    claudeSdkParityV1: process.env.NEXT_PUBLIC_CLAUDE_SDK_PARITY_V1,
    claudeSdkSessionStore: process.env.NEXT_PUBLIC_CLAUDE_SDK_SESSION_STORE,
    claudeSdkCheckpoint: process.env.NEXT_PUBLIC_CLAUDE_SDK_CHECKPOINT,
    claudeSdkPrewarm: process.env.NEXT_PUBLIC_CLAUDE_SDK_PREWARM,
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

/**
 * Persist an override for one flag into the localStorage layer.
 *
 * Until this existed the module was read-only in practice: defaults are all
 * OFF, `NEXT_PUBLIC_*` is fixed at build time, and nothing ever wrote the
 * localStorage key — so any surface gated on a flag could never be switched on
 * from inside the app. Settings → Gateway → Route tickets is the first caller.
 *
 * Writes the FULL resolved override map rather than a single key so a flag the
 * env had flipped on stays on after an unrelated flag is toggled. No-ops
 * without `window` (headless brain, node tests) — env remains the only layer
 * there.
 */
export function setAgentExecutionFlag(flag: AgentExecutionFlag, value: boolean): void {
  if (typeof window === "undefined") return
  const next = { ...readStoredFlags(), [flag]: value }
  try {
    window.localStorage.setItem(AGENT_EXECUTION_FLAGS_KEY, JSON.stringify(next))
  } catch {
    // Private-mode / quota-exceeded: subscribers re-read through
    // getAgentExecutionFlags(), so a failed write surfaces as the toggle
    // snapping back rather than a lie about the flag being on.
  }
  for (const listener of listeners) listener()
}

/**
 * Deliberately a bare listener set rather than Zustand, which is this repo's
 * store primitive everywhere a component owns the state.
 *
 * This module is not component state: it is imported by `agent-executor`,
 * `dispatch-teammate`, the workflow agent-turn node and the packaged CLI
 * bundle, all of which run with no React. `useSyncExternalStore` wants exactly
 * this shape — a subscribe function plus a snapshot getter — and the snapshot
 * getter here is the pre-existing `isAgentExecutionFlagEnabled`, which resolves
 * env and localStorage rather than reading a stored value. A store would add a
 * second source of truth for the same flag and pull React state machinery into
 * the headless bundle for no gain.
 */
const listeners = new Set<() => void>()

/**
 * Subscribe to flag changes made through {@link setAgentExecutionFlag}.
 *
 * Exists so a UI can read the flags via `useSyncExternalStore` instead of
 * mirroring them into component state — the mirror needs a setState in an
 * effect on mount, which cascades a second render on every consumer.
 *
 * Only same-tab writes notify: a `storage` event listener would fire for other
 * tabs too, but these flags change agent execution routing mid-run, so picking
 * up another tab's edit under a live agent is worse than being briefly stale.
 */
export function subscribeToAgentExecutionFlags(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
