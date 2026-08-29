import { clearAllPluginApiPermissions } from "@/lib/plugin/api/permission-api"
import { disposePluginManager, getPluginManager } from "@/lib/plugin/core/manager"
import { getPluginConsentBroker, resetPluginConsentBroker } from "./consent-broker"
import { resetPermissionGuard } from "./permission-guard"
import { blockPluginRuntimeAccount, clearPluginRuntimeAccount } from "./account-runtime-gate"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

interface PluginAccountTeardownDependencies {
  block: (accountId: string) => void
  rejectPendingConsent: () => void
  runtimePluginIds: () => string[]
  unload: (pluginId: string) => Promise<void>
  clearConsent: () => void
  clearPermissionGuard: () => void
  clearApiPermissions: () => void
  disposeManager: () => void
  clearAccount: () => void
}

function defaultDependencies(): PluginAccountTeardownDependencies {
  return {
    block: blockPluginRuntimeAccount,
    rejectPendingConsent: () => getPluginConsentBroker().rejectAllPending(),
    runtimePluginIds: () =>
      Object.values(usePluginStore.getState().plugins)
        .filter((plugin) => !["discovered", "installed"].includes(plugin.status))
        .map((plugin) => plugin.manifest.id),
    unload: async (pluginId) => getPluginManager().unloadPlugin(pluginId),
    clearConsent: resetPluginConsentBroker,
    clearPermissionGuard: resetPermissionGuard,
    clearApiPermissions: clearAllPluginApiPermissions,
    disposeManager: disposePluginManager,
    clearAccount: clearPluginRuntimeAccount,
  }
}

/**
 * Stop every plugin capability before an account database or identity changes.
 * Cleanup caches even when one runtime refuses to unload; the aggregate error
 * keeps a profile switch fail-closed while account lock can still complete.
 */
export async function teardownPluginAccountRuntime(
  accountId: string,
  overrides: Partial<PluginAccountTeardownDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies(), ...overrides }
  deps.block(accountId)
  deps.rejectPendingConsent()
  const failures: unknown[] = []
  for (const pluginId of deps.runtimePluginIds()) {
    try {
      await deps.unload(pluginId)
    } catch (error) {
      failures.push(error)
    }
  }
  deps.clearConsent()
  deps.clearPermissionGuard()
  deps.clearApiPermissions()
  deps.disposeManager()
  deps.clearAccount()
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "Plugin account runtime teardown was incomplete.")
  }
}
