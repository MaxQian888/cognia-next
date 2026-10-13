import type { Plugin, PluginManifest, PluginPermission } from "@/types/plugin"
import { usePluginStore } from "@/stores/plugin-runtime"
import { satisfiesConstraint } from "../package/dependency-resolver"
import { pluginRuntimeAccountAvailable } from "../security/account-runtime-gate"
import { getPermissionGuard } from "../security/permission-guard"
import { getPluginConsentBroker } from "../security/consent-broker"

export class PluginLibraryError extends Error {
  constructor(
    readonly code: "dependency" | "unavailable" | "runtime" | "consent" | "disposed" | "contract",
    message: string
  ) {
    super(message)
    this.name = "PluginLibraryError"
  }
}

export function supportsPluginLibraries(manifest: PluginManifest): boolean {
  return (
    ["frontend", "hybrid", "python"].includes(manifest.type) &&
    !manifest.engines?.node &&
    manifest.runtimeCompatibility?.tauri?.entrypoint !== "node"
  )
}

/** Eligibility is host-owned and never inferred from an author's caller list. */
export function assertLibraryAccess(
  callerId: string,
  providerId: string
): { caller: Plugin; provider: Plugin } {
  const { plugins } = usePluginStore.getState()
  const caller = plugins[callerId]
  const provider = plugins[providerId]
  if (!pluginRuntimeAccountAvailable() || !caller || !provider?.manifest.library) {
    throw new PluginLibraryError("unavailable", "Library or calling plugin is unavailable")
  }
  if (!supportsPluginLibraries(caller.manifest) || !supportsPluginLibraries(provider.manifest)) {
    throw new PluginLibraryError("runtime", "This runtime does not support library plugins")
  }
  if (!["loaded", "enabled", "suspended"].includes(provider.status) || caller.status === "error") {
    throw new PluginLibraryError("unavailable", `Library ${providerId} is not active`)
  }
  if (callerId !== providerId) {
    const dependencies = caller.manifest.dependencies
    const range =
      dependencies && Object.hasOwn(dependencies, providerId) && dependencies[providerId]
    if (!range || !satisfiesConstraint(provider.manifest.version, range)) {
      throw new PluginLibraryError(
        "dependency",
        `Compatible required dependency ${providerId} is missing`
      )
    }
  }
  return { caller, provider }
}

/** Permission checks before and after consent do not grant either principal anything. */
export async function authorizeLibraryAccess(
  callerId: string,
  providerId: string,
  requiredPermissions: PluginPermission[],
  operation: string
): Promise<() => void> {
  const initial = assertLibraryAccess(callerId, providerId)
  const callerManifest = initial.caller.manifest
  const providerManifest = initial.provider.manifest
  const guard = getPermissionGuard()
  const principals = [...new Set([callerId, providerId])]
  const permissions = [...new Set(requiredPermissions)]
  const context = `library:${providerId}:${operation}:caller:${callerId}`
  const recheck = () => {
    const current = assertLibraryAccess(callerId, providerId)
    if (
      current.caller.manifest !== callerManifest ||
      current.provider.manifest !== providerManifest
    ) {
      throw new PluginLibraryError("disposed", "Library or caller changed during the operation")
    }
    guard.require(callerId, "ipc:call", context)
    for (const principal of principals) {
      for (const permission of permissions) guard.require(principal, permission, context)
    }
  }
  recheck()
  for (const principal of principals) {
    for (const permission of permissions) {
      if (guard.getTier(principal, permission) !== "confirm") continue
      if (typeof window === "undefined") {
        throw new PluginLibraryError(
          "consent",
          "Interactive library consent is unavailable on this host"
        )
      }
      const allowed = await guard.checkWithConsent(
        principal,
        permission,
        getPluginConsentBroker(),
        {
          reason: context,
          context,
        }
      )
      recheck()
      if (!allowed) throw new PluginLibraryError("consent", "Library permission consent was denied")
    }
  }
  recheck()
  return recheck
}
