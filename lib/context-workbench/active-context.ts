import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextResource } from "@/types/context-workbench"

interface ActiveContextHost {
  scopeKey: string
  resource: ContextResource
  touchedAt: number
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

export function setActiveContextForHost(scopeKey: string, resource: ContextResource): () => void {
  hosts.set(scopeKey, { scopeKey, resource: cloneResource(resource), touchedAt: Date.now() })
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

export function revealPluginContextPanel(pluginId: string, requestedPanelId: string): boolean {
  const active = activeScopeKey ? hosts.get(activeScopeKey) : newestHost()
  if (!active) return false
  const panelId = requestedPanelId.startsWith(`${pluginId}:`)
    ? requestedPanelId
    : `${pluginId}:${requestedPanelId}`
  if (!panelId.startsWith(`${pluginId}:`)) return false
  const panel = contextPanelRegistry.get(panelId)
  if (!panel || panel.pluginId !== pluginId || !panel.appliesTo(active.resource)) return false
  if (
    panel.requiredCapabilities?.some(
      (capability) => !active.resource.capabilities.includes(capability)
    )
  ) {
    return false
  }
  if (!(panel.hasRequiredPermissions?.() ?? true)) return false
  useContextWorkbenchStore
    .getState()
    .smartReveal(active.scopeKey, panelId, panel.preferredMode ?? "narrow")
  return true
}

export function resetActiveContextForTesting(): void {
  hosts.clear()
  activeScopeKey = null
  notify()
}
