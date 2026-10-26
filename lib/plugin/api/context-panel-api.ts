import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveContextPanelIcon } from "@/lib/context-workbench/panel-icons"
import {
  getActiveContextResource,
  getActiveWorkbench,
  isPluginContextPanelVisible,
  revealPluginContextPanel,
  setActiveWorkbenchMode,
  setActiveWorkbenchPinned,
  setPluginContextPanelBadge,
  subscribeActiveContext,
  subscribeActiveWorkbench,
} from "@/lib/context-workbench/active-context"
import { CONTEXT_RESOURCE_READ_PERMISSIONS } from "@/types/context-workbench"
import type { ContextResource } from "@/types/context-workbench"
import type {
  PluginContextPanelAPI,
  PluginContextWorkbenchState,
} from "@cognia/plugin-contract/lib/plugin/api/context-panel-api"
export type {
  PluginContextPanelAPI,
  PluginContextPanelRegistration,
  PluginContextWorkbenchState,
} from "@cognia/plugin-contract/lib/plugin/api/context-panel-api"

/**
 * Re-exported so existing importers keep their path; the map itself lives with
 * the resource union it indexes, shared with the manifest validator.
 */
export { CONTEXT_RESOURCE_READ_PERMISSIONS }

export function createContextPanelAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginContextPanelAPI {
  const getPermittedActiveContext = (): ContextResource | null => {
    const context = getActiveContextResource()
    if (!context) return null
    return hasPermission("extension:ui") &&
      hasPermission(CONTEXT_RESOURCE_READ_PERMISSIONS[context.kind])
      ? context
      : null
  }
  const getPermittedWorkbenchState = (): PluginContextWorkbenchState | null => {
    const active = getActiveWorkbench()
    if (!active) return null
    // Same gate as the resource read above: no permission, no visibility into
    // what the user is looking at.
    if (
      !hasPermission("extension:ui") ||
      !hasPermission(CONTEXT_RESOURCE_READ_PERMISSIONS[active.resource.kind])
    ) {
      return null
    }
    const prefix = `${pluginId}:`
    return {
      resource: active.resource,
      mode: active.layout.mode,
      activePanelId: active.layout.activePanelId,
      splitPanelId: active.layout.splitPanelId,
      splitRatio: active.layout.splitRatio,
      ownsActivePanel: active.layout.activePanelId?.startsWith(prefix) ?? false,
      userPinned: active.layout.userPinned,
      // Only this plugin's own panels — the full list would leak which other
      // contributors and native surfaces are mounted.
      panelIds: contextPanelRegistry
        .resolve(active.resource)
        .filter((panel) => panel.pluginId === pluginId)
        .map((panel) => panel.id),
    }
  }
  return {
    register(registration) {
      const required = [
        "extension:ui",
        ...registration.resourceKinds.map((kind) => CONTEXT_RESOURCE_READ_PERMISSIONS[kind]),
        ...(registration.requiredPermissions ?? []),
      ].filter((permission, index, permissions) => permissions.indexOf(permission) === index)
      const denied = required.find((permission) => !hasPermission(permission))
      if (denied) {
        throw new Error(`Permission denied: ${denied} is required to register a context panel`)
      }

      return contextPanelRegistry.register({
        id: `${pluginId}:${registration.id}`,
        activity: registration.activity,
        labelKey: registration.labelKey,
        label: registration.label,
        icon: resolveContextPanelIcon(registration.icon),
        order: registration.order,
        appliesTo: (resource) => registration.resourceKinds.includes(resource.kind),
        requiredCapabilities: registration.requiredCapabilities,
        getBadge: registration.getBadge,
        requiresChatScope: registration.requiresChatScope,
        // Declared for diagnostics; the gate is the closure below, which is the
        // only form that can see *this* plugin's grants.
        requiredPermissions: required,
        hasRequiredPermissions: () => required.every((permission) => hasPermission(permission)),
        preferredMode: registration.preferredMode,
        retention: registration.retention ?? "stateful",
        renderer: registration.renderer,
        onFirstActivate: registration.onFirstActivate,
        onRestore: registration.onRestore,
        pluginId,
      })
    },
    reveal: (panelId, mode) => revealPluginContextPanel(pluginId, panelId, mode),
    setBadge: (panelId, count) =>
      hasPermission("extension:ui") && setPluginContextPanelBadge(pluginId, panelId, count),
    getActiveContext: getPermittedActiveContext,
    onDidChangeActiveContext(listener) {
      return subscribeActiveContext(() => listener(getPermittedActiveContext()))
    },
    getWorkbenchState: getPermittedWorkbenchState,
    onDidChangeWorkbenchState(listener) {
      return subscribeActiveWorkbench(() => listener(getPermittedWorkbenchState()))
    },
    setMode: (mode) => hasPermission("extension:ui") && setActiveWorkbenchMode(pluginId, mode),
    setPinned: (pinned) =>
      hasPermission("extension:ui") && setActiveWorkbenchPinned(pluginId, pinned),
    onDidChangeVisibility(panelId, listener) {
      const compute = () =>
        hasPermission("extension:ui") && isPluginContextPanelVisible(pluginId, panelId)
      let last = compute()
      return subscribeActiveWorkbench(() => {
        const next = compute()
        if (next === last) return
        last = next
        listener(next)
      })
    },
  }
}
