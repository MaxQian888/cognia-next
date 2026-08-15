import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import {
  useContextWorkbenchStore,
  visibleContextPanelIds,
  type ContextWorkbenchLayout,
} from "@/stores/context-workbench/context-workbench-store"
import type {
  ContextActivity,
  ContextPanelMode,
  ContextResource,
  ContextWorkbenchMode,
} from "@/types/context-workbench"

/**
 * The part of a panel definition that survives leaving the workbench.
 *
 * Native panels are declared inline by each host (the chat dock, Canvas, the
 * workflow and project editors) and handed over as a prop — only *plugin*
 * panels reach `contextPanelRegistry`. So anything outside the workbench that
 * wants to name a panel (the command palette, the activity shortcuts) has no
 * way to enumerate them. Publishing this projection is that way; it carries
 * identity and labelling only, never renderers or callbacks.
 */
export interface ActiveContextPanel {
  id: string
  activity: ContextActivity
  labelKey: string
  label?: string
  pluginId?: string
  preferredMode?: ContextPanelMode
}

interface ActiveContextHost {
  scopeKey: string
  resource: ContextResource
  touchedAt: number
  panels: ActiveContextPanel[]
  /**
   * Bring the host's own container on screen. The workbench store only decides
   * *which panel* is in front; whether the surface around it is visible belongs
   * to the host — the chat dock keeps its collapsed flag in
   * `artifact-dock-layout-store`, and the mobile sheet's `open` is owned by the
   * component that renders it. Without this a plugin `reveal()` on a collapsed
   * dock returned true and changed nothing on screen.
   */
  ensureVisible?: () => void
  /**
   * Shut the host's own container — the dual of {@link ensureVisible}. Without
   * it a plugin's `setMode("collapsed")` wrote the per-scope layout mode and
   * stopped there, which the chat dock does not read: its collapsed flag lives
   * in `artifact-dock-layout-store`, so the call returned true and nothing
   * moved on screen.
   */
  collapse?: () => void
  /**
   * Whether the host's container is actually showing its panel body right now.
   *
   * The counterpart to `ensureVisible` on the *reporting* side. Visibility used
   * to be inferred from `layout.mode !== "collapsed"`, a per-scope field the
   * chat dock never writes — so while the dock sat at zero width a plugin's
   * `onDidChangeVisibility` still reported its panel as visible. Hosts that are
   * always on screen omit it and are treated as visible.
   */
  isVisible?: () => boolean
  /**
   * Which panels the host is actually showing — one normally, two while split.
   *
   * The layout alone cannot answer this. It records a split the host may be
   * projecting away: the mobile drawer and any body too narrow for two panes
   * render a single pane deliberately without writing back, so that a phone
   * cannot destroy a desktop layout. Reading `splitPanelId` directly would
   * report a second pane as visible on a device that is not drawing one —
   * the same class of lie `isVisible` was added to fix. Hosts that predate
   * this omit it and fall back to the layout.
   */
  visiblePanelIds?: () => string[]
}

export interface ActiveContextHostOptions {
  ensureVisible?: () => void
  collapse?: () => void
  isVisible?: () => boolean
  visiblePanelIds?: () => string[]
}

const hosts = new Map<string, ActiveContextHost>()
const listeners = new Set<() => void>()
let activeScopeKey: string | null = null
let revision = 0

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
  revision++
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
    // Carried over: the panel list is published by a separate effect that may
    // have run before this one on a resource change, and dropping it here would
    // blank the palette until the next registry mutation.
    panels: hosts.get(scopeKey)?.panels ?? [],
    ensureVisible: options.ensureVisible,
    collapse: options.collapse,
    isVisible: options.isVisible,
    visiblePanelIds: options.visiblePanelIds,
  })
  activeScopeKey = scopeKey
  notify()
  return () => {
    hosts.delete(scopeKey)
    if (activeScopeKey === scopeKey) activeScopeKey = newestHost()?.scopeKey ?? null
    notify()
  }
}

/**
 * Re-broadcast because a host's own visibility flipped.
 *
 * Deliberately narrower than {@link setActiveContextForHost}: that one also
 * stamps `touchedAt` and makes the host active, so re-registering on every
 * collapse would let a background workbench steal "in front" from the one the
 * user is actually looking at. Collapsing a surface is the opposite of
 * claiming focus.
 *
 * Unknown scopes are dropped, not queued — the host republishes on its next
 * render, exactly like {@link publishActiveContextPanels}.
 */
export function notifyActiveContextHostVisibility(scopeKey: string): void {
  if (!hosts.has(scopeKey)) return
  notify()
}

export function touchActiveContextHost(scopeKey: string): void {
  const host = hosts.get(scopeKey)
  if (!host) return
  host.touchedAt = Date.now()
  activeScopeKey = scopeKey
  notify()
}

/**
 * Record which panels the workbench at `scopeKey` currently resolves to.
 *
 * Separate from {@link setActiveContextForHost} because the two change on
 * different clocks: the resource changes when the user moves between artifacts,
 * while the panel set also changes whenever a plugin registers or a context key
 * flips. Folding them together would re-register the host on every registry
 * mutation. A publish for an unknown scope is dropped, not queued — the host
 * republishes on its next render.
 */
export function publishActiveContextPanels(scopeKey: string, panels: ActiveContextPanel[]): void {
  const host = hosts.get(scopeKey)
  if (!host) return
  host.panels = panels.map((panel) => ({ ...panel }))
  notify()
}

/** Panels of the workbench currently in front, or `[]` when there is none. */
export function getActiveWorkbenchPanels(): ActiveContextPanel[] {
  return (activeHost()?.panels ?? []).map((panel) => ({ ...panel }))
}

/**
 * Bring `panelId` to the front of the active workbench, opening its container
 * first. Returns false when no workbench is mounted or it has no such panel.
 *
 * Unlike {@link revealPluginContextPanel} there is no ownership check: the
 * callers are first-party surfaces acting on a direct user request (the command
 * palette, the activity shortcuts), not a contributor reaching across.
 */
export function revealActiveWorkbenchPanel(panelId: string, mode?: ContextPanelMode): boolean {
  const active = activeHost()
  if (!active) return false
  const panel = active.panels.find((candidate) => candidate.id === panelId)
  if (!panel) return false
  active.ensureVisible?.()
  useContextWorkbenchStore
    .getState()
    .smartReveal(active.scopeKey, panel.id, mode ?? panel.preferredMode ?? "narrow")
  return true
}

/**
 * Bring the active workbench's panel for `activity` to the front.
 *
 * Resolves to the *first* panel in that activity group, matching what clicking
 * the rail button does. Returns false when the mounted workbench has no panel
 * for it — a session surface has no `comments`, for instance. Callers must let
 * that be a no-op rather than falling back to a neighbouring activity, or a
 * fixed keybinding would quietly mean different things on different surfaces.
 */
export function revealActiveWorkbenchActivity(activity: ContextActivity): boolean {
  const active = activeHost()
  if (!active) return false
  const panel = active.panels.find((candidate) => candidate.activity === activity)
  return panel ? revealActiveWorkbenchPanel(panel.id) : false
}

export function getActiveContextResource(): ContextResource | null {
  const active = activeScopeKey ? hosts.get(activeScopeKey) : newestHost()
  return active ? cloneResource(active.resource) : null
}

export function subscribeActiveContext(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Monotonic counter for `useSyncExternalStore`. A primitive, because the
 * accessors here return fresh clones every call and React rejects a snapshot
 * whose identity changes — subscribers read the revision and then call the
 * accessor they actually want.
 */
export function getActiveContextRevision(): number {
  return revision
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
  // Collapsing has to reach the *host*: three of the four hosts shrink a
  // container they own and never read the per-scope mode, so writing it alone
  // returned true and left the panel exactly where it was. Hosts without a
  // container of their own supply no `collapse` and fall through to the mode,
  // which for them is the real thing.
  if (mode === "collapsed") {
    const collapse = hosts.get(active.scopeKey)?.collapse
    if (collapse) {
      collapse()
      return true
    }
  }
  useContextWorkbenchStore.getState().setMode(active.scopeKey, mode)
  return true
}

/**
 * Whether a plugin's panel is on screen in the ACTIVE workbench — in either
 * pane, since a split shows two at once. This is the host-side notion of
 * visibility, coarser than the per-iframe `visibility` event the webview
 * renderer pushes, which knows exactly which frame instance is displayed.
 */
export function isPluginContextPanelVisible(pluginId: string, requestedPanelId: string): boolean {
  const active = getActiveWorkbench()
  if (!active) return false
  const host = hosts.get(active.scopeKey)
  // Ask the host first. It is the only party that knows about the projections
  // that narrow a split away at render time without touching the layout, so
  // reading the layout alone would report a second pane as visible on a phone
  // that is drawing one.
  const visible = host?.visiblePanelIds?.() ?? visibleContextPanelIds(active.layout)
  return (
    visible.includes(qualifyPluginPanelId(pluginId, requestedPanelId)) &&
    active.layout.mode !== "collapsed" &&
    // …and the container around it is actually open. `mode` is per-scope and
    // three of the four hosts never write `collapsed` to it, so this used to
    // report a panel as visible while the whole right column sat at zero width.
    (host?.isVisible?.() ?? true)
  )
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
