import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { AGENT_STATE_KEY_ENV, agentStateIsolationFor } from "../policy/security-policy"
import {
  applyStateIsolation,
  isStateIsolated,
  stateIsolationBlockReason,
} from "./launch-preparation"
import { getExternalAgentStateRootInfo } from "./state-root"

export type IsolatedTerminalEnv =
  | { kind: "shared" }
  | { kind: "isolated"; env: Record<string, string> }
  | { kind: "unavailable"; reason: "no-state-root" | "isolation-unsupported" }

/** Resolve the same private homes used by the spawn backends for an interactive terminal. */
export async function resolveIsolatedTerminalEnv(
  config: Omit<ExternalAgentConfig, "createdAt" | "updatedAt">
): Promise<IsolatedTerminalEnv> {
  if (!isStateIsolated(config) || config.transport !== "stdio" || !config.process?.command) {
    return { kind: "shared" }
  }
  const rule = agentStateIsolationFor(config.process.command, config.process.args ?? [])
  if (!rule) return { kind: "shared" }
  if (stateIsolationBlockReason(config)) {
    return { kind: "unavailable", reason: "isolation-unsupported" }
  }
  // The launch preparer also exempts gateway tasks and already-isolated bot runs.
  if (!applyStateIsolation(config).process?.env?.[AGENT_STATE_KEY_ENV]) return { kind: "shared" }
  const root = await getExternalAgentStateRootInfo(config.id)
  if (!root) return { kind: "unavailable", reason: "no-state-root" }
  const separator = root.path.includes("\\") ? "\\" : "/"
  const base = root.path.replace(/[\\/]+$/, "")
  return {
    kind: "isolated",
    env: Object.fromEntries(
      Object.entries(rule.env).map(([key, directory]) => [key, `${base}${separator}${directory}`])
    ),
  }
}
