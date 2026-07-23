import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import {
  useContextWorkbenchStore,
  type ContextWorkbenchLayout,
} from "@/stores/context-workbench/context-workbench-store"
import type {
  ContextPanelMode,
  ContextResource,
  ContextWorkbenchMode,
} from "@/types/context-workbench"

interface ActiveContextHost {
  scopeKey: string
  resource: ContextResource
  touchedAt: number
  /**
   * Bring the host's own container on screen. The workbench store only decides
   * *which panel* is in front; whether the surface around it is visible belongs
   * to the host — the chat dock keeps its collapsed flag in
   * `artifact-dock-layout-store`, and the mobile sheet's `open` is owned by the
   * component that renders it. Without this a plugin `reveal()` on a collapsed
   * dock returned true and changed nothing on screen.
   */
  ensureVisible?: () => void
}

export interface ActiveContextHostOptions {
  ensureVisible?: () => void
}

const hosts = new Map<string, ActiveContextHost>()
const listeners = new Set<() => void>()
let activeScopeKey: string | null = null

function cloneResource(resource: ContextResource): ContextResource {
  if (resource.kind === "canvas-document") {
    return {
      ...resource,
      capabilities: [...resource.capabilities],
      selection: resource.selection
        ? {
            ...resource.selection,
            blockIds: [...resource.selection.blockIds],
            text: resource.selection.text ? { ...resource.selection.text } : undefined,
          }
        : undefined,
    }
  }
  if (resource.kind === "workflow") {
    return {
      ...resource,
      capabilities: [...resource.capabilities],
      selection: resource.selection
        ? {
            ...resource.selection,
            nodeIds: [...resource.selection.nodeIds],
            edgeIds: [...resource.selection.edgeIds],
          }
        : undefined,
    }
  }
  if (resource.kind === "session") {
    // A session never carries a selection, so there is nothing else to clone.
    return { ...resource, capabilities: [...resource.capabilities] }
  }
  return {
    ...resource,
    capabilities: [...resource.capabilities],
    selection: resource.selection ? { ...resource.selection } : undefined,
  }
}

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // A plugin listener cannot block other active-context subscribers.
    }
  })
}

function newestHost(): ActiveContextHost | undefined {
  return [...hosts.values()].sort((left, right) => right.touchedAt - left.touchedAt)[0]
}

export function setActiveContextForHost(
  scopeKey: string,
  resource: ContextResource,
  options: ActiveContextHostOptions = {}
): () => void {
  hosts.set(scopeKey, {
    scopeKey,
    resource: cloneResource(resource),
    touchedAt: Date.now(),
    ensureVisible: options.ensureVisible,
  })
  activeScopeKey = scopeKey
  notify()
  return () => {
    hosts.delete(scopeKey)
    if (activeScopeKey === scopeKey) activeScopeKey = newestHost()?.scopeKey ?? null
    notify()
  }
}

export function touchActiveContextHost(scopeKey: string): void {
  const host = hosts.get(scopeKey)
  if (!host) return
  host.touchedAt = Date.now()
  activeScopeKey = scopeKey
  notify()
}

export function getActiveContextResource(): ContextResource | null {
  const active = activeScopeKey ? hosts.get(activeScopeKey) : newestHost()
  return active ? cloneResource(active.resource) : null
}

export function subscribeActiveContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function activeHost(): ActiveContextHost | undefined {
  return activeScopeKey ? hosts.get(activeScopeKey) : newestHost()
}

/**
 * Namespace an id the way the registry stores it. A plugin passing someone
 * else's qualified id just gets its own prefix stacked on top, which resolves
 * to nothing — the ownership check never depends on the caller's spelling.
 */
function qualifyPluginPanelId(pluginId: string, requestedPanelId: string): string {
  return requestedPanelId.startsWith(`${pluginId}:`)
    ? requestedPanelId
    : `${pluginId}:${requestedPanelId}`
}

function resolvePluginPanel(pluginId: string, requestedPanelId: string, resource: ContextResource) {
  const panel = contextPanelRegistry.get(qualifyPluginPanelId(pluginId, requestedPanelId))
  if (!panel || panel.pluginId !== pluginId || !panel.appliesTo(resource)) return null
  if (panel.requiredCapabilities?.some((capability) => !resource.capabilities.includes(capability)))
    return null
  if (!(panel.hasRequiredPermissions?.() ?? true)) return null
  return panel
}

export function revealPluginContextPanel(
  pluginId: string,
  requestedPanelId: string,
  mode?: ContextPanelMode
): boolean {
  const active = activeHost()
  if (!active) return false
  const panel = resolvePluginPanel(pluginId, requestedPanelId, active.resource)
  if (!panel) return false
  // Open the container before choosing the panel inside it: a pinned workbench
  // turns the reveal into a pending badge, and that badge is only worth showing
  // if the rail it sits on is actually on screen.
  active.ensureVisible?.()
  useContextWorkbenchStore
    .getState()
    .smartReveal(active.scopeKey, panel.id, mode ?? panel.preferredMode ?? "narrow")
  return true
}

export function setPluginContextPanelBadge(
  pluginId: string,
  requestedPanelId: string,
  count: number
): boolean {
  const panelId = qualifyPluginPanelId(pluginId, requestedPanelId)
  const panel = contextPanelRegistry.get(panelId)
  if (!panel || panel.pluginId !== pluginId) return false
  return contextPanelRegistry.setBadge(panelId, count)
}

export interface ActiveWorkbenchSnapshot {
  scopeKey: string
  resource: ContextResource
  layout: ContextWorkbenchLayout
}

export function getActiveWorkbench(): ActiveWorkbenchSnapshot | null {
  const active = activeHost()
  if (!active) return null
  const layout = useContextWorkbenchStore.getState().layouts[active.scopeKey]
  if (!layout) return null
  return { scopeKey: active.scopeKey, resource: cloneResource(active.resource), layout }
}

/**
 * Layout control is gated on the plugin already owning the visible panel. A
 * contributor may resize or pin the surface its own panel is sitting in; it may
 * not full-screen the right rail while the user is reading someone else's.
 */
function ownedActiveWorkbench(pluginId: string): ActiveWorkbenchSnapshot | null {
  const active = getActiveWorkbench()
  if (!active) return null
  const panelId = active.layout.activePanelId
  return panelId && panelId.startsWith(`${pluginId}:`) ? active : null
}

export function setActiveWorkbenchMode(pluginId: string, mode: ContextWorkbenchMode): boolean {
  const active = ownedActiveWorkbench(pluginId)
  if (!active) return false
  useContextWorkbenchStore.getState().setMode(active.scopeKey, mode)
  return true
}

export function setActiveWorkbenchPinned(pluginId: string, pinned: boolean): boolean {
  const active = ownedActiveWorkbench(pluginId)
  if (!active) return false
  useContextWorkbenchStore.getState().setUserPinned(active.scopeKey, pinned)
  return true
}

/**
 * Fires for both halves of the workbench state: which resource is in front
 * (active-context hosts) and how it is laid out (the persisted layout store).
 * A subscriber that only listened to the former would miss the user switching
 * panels or widening the rail.
 */
export function subscribeActiveWorkbench(listener: () => void): () => void {
  const unsubscribeContext = subscribeActiveContext(listener)
  const unsubscribeLayout = useContextWorkbenchStore.subscribe(listener)
  return () => {
    unsubscribeContext()
    unsubscribeLayout()
  }
}

export function resetActiveContextForTesting(): void {
  hosts.clear()
  activeScopeKey = null
  notify()
}
