/**
 * Resolve a preset(+config) binding to a registered external-agent id.
 *
 * The selection rules live in the pure
 * `lib/ai/agent/external/config/agent-binding.ts`; this module feeds them the
 * two live sources (the user's saved configs and the manager's registered
 * instances) and, for a pinned config the manager has never been given,
 * registers it through {@link ensureExternalAgentReady} so the first
 * `manager.execute` does not die on `Agent not found`.
 *
 * Shared by the Agent Team teammate backing
 * (`lib/ai/agent/team/teammate/resolve-external-backing.ts`) and the plugin/app
 * subagent dispatch (`lib/plugin/agent-sdk/dispatch.ts`). Neither spawns a
 * fresh config for a pin: a pin that cannot run throws
 * {@link ExternalAgentBindingError}. Spawning from the preset when a bare
 * preset has no live config stays the caller's decision, because the two
 * callers answer an unknown preset differently.
 */

import {
  ExternalAgentBindingError,
  normalizePinnedConfigId,
  resolveExternalAgentBinding,
  toExternalAgentCandidate,
  type ExternalAgentBinding,
  type ExternalAgentBindingResolution,
} from "@/lib/ai/agent/external/config/agent-binding"
import { ensureExternalAgentReady } from "@/lib/agent/ensure-external-agent-ready"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

export async function resolveExternalAgentForBinding(
  binding: ExternalAgentBinding
): Promise<ExternalAgentBindingResolution> {
  const [{ getExternalAgentManager }, { isFromPreset }] = await Promise.all([
    import("@/lib/ai/agent/external/manager"),
    import("@/lib/ai/agent/external/config/presets"),
  ])
  const manager = getExternalAgentManager()
  const live = manager
    .getAllAgents()
    .map((instance) =>
      toExternalAgentCandidate(
        instance.config,
        instance.connectionStatus,
        isFromPreset(instance.config)
      )
    )

  const configId = normalizePinnedConfigId(binding.configId)
  if (!configId) return resolveExternalAgentBinding({ presetId: binding.presetId }, { live })

  const store = useExternalAgentStore.getState()
  const stored = Object.values(store.agents ?? {}).map((config) =>
    toExternalAgentCandidate(config, store.connectionStatus?.[config.id])
  )
  const resolution = resolveExternalAgentBinding(
    { presetId: binding.presetId, configId },
    { live, stored }
  )

  if (!manager.getAgent(configId)) {
    // Register only; `manager.execute` connects on first use, with the
    // dispatch's own gateway binding deciding how.
    const readiness = await ensureExternalAgentReady(configId, { deferConnect: true })
    if (!readiness.ok) {
      throw new ExternalAgentBindingError(
        readiness.reason === "unknown-agent" ? "missing" : "unavailable",
        configId,
        binding.presetId,
        undefined,
        readiness.reason === "unknown-agent" ? undefined : readiness.detail
      )
    }
  }
  return resolution
}
