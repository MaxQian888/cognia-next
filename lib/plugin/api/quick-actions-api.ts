// Plugin-facing quick-actions API. Mirrors `createTrayAPI`
// (`lib/plugin/api/tray-api.ts`) exactly — the contract is:
//
//   1. The registry namespaces the user-supplied id as
//      `<pluginId>:<localId>` so two plugins can register the same local
//      id without colliding.
//   2. Registration flows through `registerQuickAction`, which mirrors a
//      dispatch command into `lib/plugin/commands/registry.ts` so the
//      palette / composer / tray surfaces share one `executeCommand` rail.
//   3. The returned disposer removes both the overlay entry and the
//      mirrored command.
//
// Permission gating: when the plugin doesn't declare the `"quick-action"`
// capability in its manifest, every call returns a no-op disposer.

"use client"

import { loggers } from "@/lib/logging"
import type {
  PluginCapability,
  PluginQuickActionInput,
  PluginQuickActionsAPI,
} from "@/types/plugin"
import { registerQuickAction } from "@/lib/plugin/registries/quick-action-registry"

interface CreateQuickActionsAPIArgs {
  pluginId: string
  capabilities: readonly PluginCapability[]
}

export function createQuickActionsAPI({
  pluginId,
  capabilities,
}: CreateQuickActionsAPIArgs): PluginQuickActionsAPI {
  if (!capabilities.includes("quick-action")) return noopQuickActionsAPI(pluginId)

  return {
    register: (action: PluginQuickActionInput) => registerQuickAction(pluginId, action),
    registerMany: (actions: PluginQuickActionInput[]) => {
      const disposers = actions.map((action) => registerQuickAction(pluginId, action))
      return () => disposers.forEach((d) => d())
    },
  }
}

function noopQuickActionsAPI(pluginId: string): PluginQuickActionsAPI {
  const warnOnce = createWarnOnce(pluginId)
  return {
    register: () => {
      warnOnce()
      return () => {}
    },
    registerMany: () => {
      warnOnce()
      return () => {}
    },
  }
}

function createWarnOnce(pluginId: string): () => void {
  let warned = false
  return () => {
    if (warned) return
    warned = true
    loggers.plugin.warn(
      "plugin tried to register a quick action without the 'quick-action' capability — declare it in plugin.json",
      { pluginId }
    )
  }
}
