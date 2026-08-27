import type { ComponentType } from "react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { resolveContextPanelIcon } from "@/lib/context-workbench/panel-icons"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"
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
import type {
  ContextActivity,
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
  /**
   * Rail group this panel joins.
   *
   * A canonical activity shares a rail button with the built-in panels already
   * in it — six of them under `inspect`, where a seventh is a tab behind a `⋯`
   * overflow rather than something anyone finds. A non-canonical id gets the
   * plugin its OWN rail button instead: the registry, the rail sort order and
   * the customizer catalog all already handle unknown activities (the rail
   * draws the active panel's own icon and label, and unknown ids sort after
   * the canonical ones), so nothing here had to grow a special case.
   *
   * Prefer a canonical activity when the panel genuinely belongs beside the
   * built-ins; reach for a custom one when it is a destination of its own.
   */
  activity: ContextActivity
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
  /**
   * The panel stacked below `activePanelId` while the workbench is split, or
   * `null`. Namespaced like `activePanelId`.
   *
   * Note this is the *stored* layout: a host may be projecting the split away
   * (the mobile drawer, or a body too narrow for two panes). Use
   * `onDidChangeVisibility` to learn whether a given panel is actually drawn.
   */
  splitPanelId: string | null
  /** Percentage of the body height the primary pane occupies (20–80). */
  splitRatio: number
  /**
   * True when the panel *in front* belongs to this plugin — the gate on
   * `setMode`/`setPinned`.
   *
   * Deliberately not satisfied by owning only the split pane: those two calls
   * reshape the whole workbench, and a plugin sitting in the lower half has not
   * been handed the surface.
   */
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
  /**
   * Observe whether one of this plugin's panels is the one in front of the
   * active workbench — the signal for pausing polling/animation while hidden.
   * Stateful panels stay mounted when another panel takes over, so without
   * this a panel cannot tell it left the screen. Fires only on changes.
   */
  onDidChangeVisibility: (panelId: string, listener: (visible: boolean) => void) => () => void
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
