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
 * A teammate whose config pins one exact external-agent config
 * (`TeammateConfig.externalAgentConfigId`) runs on exactly that config. A pin
 * that is missing, disabled or no longer of the runtime's preset family throws
 * `ExternalAgentBindingError` rather than borrowing another config of the
 * preset. Without a pin the live configs of the preset are ordered by the
 * shared rule in `lib/ai/agent/external/config/agent-binding.ts`.
 *
 * Returns `null` for the default (claude / sidecar) path and whenever the
 * preset cannot be resolved (e.g. unknown id, or web/mobile where external
 * agents are unavailable) — the caller then fails the dispatch with
 * `ExternalRuntimeUnavailableError`.
 */

import { normalizePinnedConfigId } from "@/lib/ai/agent/external/config/agent-binding"
import type { AgentTeammate, ResolvedCapabilities } from "@/types/agent/agent-team"
import type { TeamRunContext } from "../team-run-context"

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
 * The exact external-agent config a teammate is pinned to, or undefined.
 *
 * Only an external `runtime` reads the pin: a `claude` teammate that picks up
 * an external preset through its capability bundle has no per-teammate config
 * choice, and a pin left over from an earlier runtime must not steer it.
 */
export function resolveTeammatePinnedConfigId(teammate: AgentTeammate): string | undefined {
  const runtime = teammate.config?.runtime ?? "claude"
  if (runtime === "claude") return undefined
  return normalizePinnedConfigId(teammate.config?.externalAgentConfigId)
}

/**
 * Resolve (and lazily create + register) a connected external-agent instance
 * id for an external-backed teammate. Caches per-run by preset id; a pinned
 * config is resolved on every call (no spawn, so nothing to share).
 */
export async function resolveTeammateExternalAgent(
  teammate: AgentTeammate,
  resolvedCaps: ResolvedCapabilities,
  teamCtx: TeamRunContext
): Promise<string | null> {
  let presetId = resolveTeammatePresetId(teammate, resolvedCaps)
  if (!presetId) return null

  // External CLI agents only run on the desktop / headless host. Without this
  // guard the browser shell reached `manager.addAgent`, whose connect throws a
  // desktop-only error that escaped `dispatchTeammate` uncaught instead of
  // taking the documented failure path.
  const { supportsExternalAgents } = await import("@/lib/ai/agent/external/agent-transport")
  if (!supportsExternalAgents()) return null

  const { resolveExternalAgentForBinding } = await import("@/lib/agent/external-agent-binding")

  // The pin wins over the preset, and is checked against the DECLARED runtime
  // before the Codex surface preference below rewrites it: a teammate declared
  // as `codex` legitimately pins a config added through `codex-app-server`.
  const pinnedConfigId = resolveTeammatePinnedConfigId(teammate)
  if (pinnedConfigId) {
    const pinned = await resolveExternalAgentForBinding({ presetId, configId: pinnedConfigId })
    return pinned.agentId
  }

  const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
  const { createAgentFromPreset, resolvePreferredCodexExecutablePresetId } =
    await import("@/lib/ai/agent/external/config/presets")

  // Codex ships two executable surfaces: the native `codex app-server` and the
  // ACP shim (`@zed-industries/codex-acp`). Prefer the first-party app-server
  // when the `codex` CLI is installed, exactly like the gallery's quick-add.
  if (presetId === "codex") {
    presetId = await resolvePreferredCodexExecutablePresetId()
  }

  const cached = teamCtx.externalAgentInstances.get(presetId)
  if (cached) return cached

  // Reuse a live agent already created from this preset, else spawn one. The
  // shared rule orders the live configs deterministically and skips any that
  // carry their own gateway account: that account belongs to that agent, not
  // every team member using the same executable preset. Task bindings are
  // passed at execute.
  const existing = await resolveExternalAgentForBinding({ presetId })
  let agentId: string
  if (existing.agentId) {
    agentId = existing.agentId
  } else {
    const config = createAgentFromPreset(presetId)
    if (!config) return null
    await getExternalAgentManager().addAgent(config, { connect: !teammate.config?.cogniaModel })
    agentId = config.id
  }

  teamCtx.externalAgentInstances.set(presetId, agentId)
  return agentId
}
