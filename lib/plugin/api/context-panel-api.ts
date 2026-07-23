import type { ComponentType } from "react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveContextPanelIcon } from "@/lib/context-workbench/panel-icons"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"
import {
  getActiveContextResource,
  getActiveWorkbench,
  revealPluginContextPanel,
  setActiveWorkbenchMode,
  setActiveWorkbenchPinned,
  setPluginContextPanelBadge,
  subscribeActiveContext,
  subscribeActiveWorkbench,
} from "@/lib/context-workbench/active-context"
import { CONTEXT_RESOURCE_READ_PERMISSIONS } from "@/types/context-workbench"
import type {
  CanonicalContextActivity,
  ContextCapability,
  ContextPanelDefinition,
  ContextPanelMode,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResource,
  ContextWorkbenchMode,
} from "@/types/context-workbench"

type ContextResourceKind = ContextResource["kind"]

export interface PluginContextPanelRegistration {
  id: string
  activity: CanonicalContextActivity
  label: string
  labelKey: string
  resourceKinds: ContextResourceKind[]
  requiredCapabilities?: ContextCapability[]
  requiredPermissions?: string[]
  preferredMode?: ContextPanelMode
  retention?: ContextPanelRetention
  order?: number
  /**
   * Activity-rail glyph, named from the host's safe set — the same one the
   * manifest path accepts. Omitting it falls back to the host's generic panel
   * icon, which is what *every* imperatively-registered panel used to get.
   */
  icon?: PluginContextPanelIcon
  /**
   * Count rendered on the rail button, recomputed whenever the workbench
   * re-renders. Use this for a count derived from the resource in front; use
   * `setBadge` for one that changes on its own schedule. The two add up.
   */
  getBadge?: ContextPanelDefinition["getBadge"]
  /**
   * Mount the panel inside the resource's chat scope. The host provisions the
   * session and holds the panel on a loading state until it exists, so only ask
   * for it if the panel actually renders a conversation.
   */
  requiresChatScope?: boolean
  renderer: ComponentType<ContextPanelRenderProps>
  onFirstActivate?: ContextPanelDefinition["onFirstActivate"]
  onRestore?: ContextPanelDefinition["onRestore"]
}

/**
 * What the right-side workbench is showing right now, as far as this plugin is
 * allowed to see it. `activePanelId` and `panelIds` carry the namespaced ids
 * (`<pluginId>:<panelId>`) the registry actually stores.
 */
export interface PluginContextWorkbenchState {
  resource: ContextResource
  mode: ContextWorkbenchMode
  activePanelId: string | null
  /** True when the visible panel belongs to this plugin — the gate on `setMode`/`setPinned`. */
  ownsActivePanel: boolean
  userPinned: boolean
  panelIds: string[]
}

export interface PluginContextPanelAPI {
  register: (registration: PluginContextPanelRegistration) => () => void
  /** Bring one of this plugin's panels forward, optionally forcing a width mode. */
  reveal: (panelId: string, mode?: ContextPanelMode) => boolean
  /** Push a badge count onto one of this plugin's panels (0 clears it). */
  setBadge: (panelId: string, count: number) => boolean
  getActiveContext: () => ContextResource | null
  onDidChangeActiveContext: (listener: (context: ContextResource | null) => void) => () => void
  /** Read the workbench layout hosting the active resource, or null when none is mounted. */
  getWorkbenchState: () => PluginContextWorkbenchState | null
  onDidChangeWorkbenchState: (
    listener: (state: PluginContextWorkbenchState | null) => void
  ) => () => void
  /** Resize / full-screen the workbench. Only honoured while this plugin's panel is the visible one. */
  setMode: (mode: ContextWorkbenchMode) => boolean
  /** Pin the workbench so automatic reveals queue as badges instead of switching panels. */
  setPinned: (pinned: boolean) => boolean
}

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
  }
}
