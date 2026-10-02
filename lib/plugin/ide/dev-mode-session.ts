/**
 * Entering and leaving Managed IDE Dev Mode as one step each.
 *
 * The host switch does most of the work itself (it starts and stops the
 * broker trace, forgets registered dev folders, restores committed proxies,
 * and stops honouring `local-dev` receipts). What only the renderer can do is
 * act on plugins: leaving Dev Mode disables every running plugin that was
 * trusted only through a `local-dev` receipt, instead of leaving it running
 * on trust that has just ended. Verification results are re-checked on both
 * edges, since a refusal or acceptance may have depended on the switch.
 */

import type { Plugin } from "@/types/plugin"

import { setDevModeEnabled, type ManagedIdeDevModeStatus } from "./dev-mode"

const ACTIVE_STATUSES = new Set<Plugin["status"]>(["enabled", "enabling", "suspended"])

export interface DevModeSessionDependencies {
  plugins(): Promise<Plugin[]>
  readReceipt(pluginId: string): Promise<{ verifiedVia: string } | null>
  disablePlugin(pluginId: string, reason: string): Promise<void>
  clearVerificationCache(): Promise<void>
}

export const DEV_MODE_ENDED_REASON = "managed-ide-dev-mode-ended"

export async function enterManagedIdeDevMode(
  deps: DevModeSessionDependencies = defaultDependencies()
): Promise<ManagedIdeDevModeStatus> {
  const status = await setDevModeEnabled(true)
  await deps.clearVerificationCache()
  return status
}

export interface LeaveDevModeResult {
  status: ManagedIdeDevModeStatus
  /** Plugins disabled because their only trust was a `local-dev` receipt. */
  disabled: string[]
  /** Plugins that could not be disabled, with why. */
  failed: Array<{ pluginId: string; error: string }>
}

export async function leaveManagedIdeDevMode(
  deps: DevModeSessionDependencies = defaultDependencies()
): Promise<LeaveDevModeResult> {
  // Read receipts while Dev Mode is still on: once it is off the host stops
  // returning `local-dev` ones, and these plugins could no longer be told apart.
  const localDev: string[] = []
  for (const plugin of await deps.plugins()) {
    if (plugin.source === "builtin" || !ACTIVE_STATUSES.has(plugin.status)) continue
    const receipt = await deps.readReceipt(plugin.manifest.id).catch(() => null)
    if (receipt?.verifiedVia === "local-dev") localDev.push(plugin.manifest.id)
  }
  const status = await setDevModeEnabled(false)
  await deps.clearVerificationCache()
  const disabled: string[] = []
  const failed: LeaveDevModeResult["failed"] = []
  for (const pluginId of localDev) {
    try {
      await deps.disablePlugin(pluginId, DEV_MODE_ENDED_REASON)
      disabled.push(pluginId)
    } catch (error) {
      failed.push({ pluginId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { status, disabled, failed }
}

function defaultDependencies(): DevModeSessionDependencies {
  return {
    plugins: async () => {
      const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
      return Object.values(usePluginStore.getState().plugins)
    },
    readReceipt: async (pluginId) => {
      const { invoke } = await import("@tauri-apps/api/core")
      return invoke<{ verifiedVia: string } | null>("plugin_read_verification", { pluginId })
    },
    disablePlugin: async (pluginId, reason) => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().disablePlugin(pluginId, reason)
    },
    clearVerificationCache: async () => {
      const { getPluginSignatureVerifier } = await import("@/lib/plugin/security/signature")
      getPluginSignatureVerifier().clearCache()
    },
  }
}
