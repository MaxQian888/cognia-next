/**
 * Thread A1 — resolve the external-agent backing for a team teammate.
 *
 * A teammate whose `runtime` is not `"claude"` (one of codex / claude-code /
 * gemini-cli / cursor-cli), or whose resolved capability bundle carries an
 * `externalAgentPresetIds` entry, is dispatched to an external CLI agent via
 * the {@link ExternalAgentManager} instead of the Anthropic sidecar. This
 * module maps a teammate to a *connected* external-agent instance id, lazily
 * spawning one from the preset and caching it per-run so repeated dispatches
 * reuse a single CLI process (the manager caps live connections).
 *
 * Returns `null` for the default (claude / sidecar) path and whenever the
 * preset cannot be resolved (e.g. unknown id, or web/mobile where external
 * agents are unavailable) — the caller then falls back to the built-in path.
 */

import type { AgentTeammate, ResolvedCapabilities } from "@/types/agent/agent-team"
import type { TeamRunContext } from "./team-run-context"

/**
 * The preset id (if any) that backs a teammate. Non-`claude` runtimes map
 * directly to their preset id (the {@link TeammateRuntime} values are exactly
 * the builtin preset ids); otherwise the first resolved external preset id.
 */
export function resolveTeammatePresetId(
  teammate: AgentTeammate,
  resolvedCaps: ResolvedCapabilities
): string | null {
  const runtime = teammate.config?.runtime ?? "claude"
  if (runtime !== "claude") return runtime
  return resolvedCaps.externalAgentPresetIds?.[0] ?? null
}

/**
 * Resolve (and lazily create + register) a connected external-agent instance
 * id for an external-backed teammate. Caches per-run by preset id.
 */
export async function resolveTeammateExternalAgent(
  teammate: AgentTeammate,
  resolvedCaps: ResolvedCapabilities,
  teamCtx: TeamRunContext
): Promise<string | null> {
  const presetId = resolveTeammatePresetId(teammate, resolvedCaps)
  if (!presetId) return null

  const cached = teamCtx.externalAgentInstances.get(presetId)
  if (cached) return cached

  const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
  const { createAgentFromPreset, isFromPreset } = await import("@/lib/ai/agent/external/presets")
  const manager = getExternalAgentManager()

  // Reuse a live agent already created from this preset, else spawn one.
  const existing = manager.getAllAgents().find((inst) => isFromPreset(inst.config) === presetId)
  let agentId: string
  if (existing) {
    agentId = existing.config.id
  } else {
    const config = createAgentFromPreset(presetId)
    if (!config) return null
    await manager.addAgent(config)
    agentId = config.id
  }

  teamCtx.externalAgentInstances.set(presetId, agentId)
  return agentId
}
