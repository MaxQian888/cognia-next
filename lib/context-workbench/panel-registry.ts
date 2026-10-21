import type { ContextPanelDefinition } from "@/types/context-workbench"
import type { ContextPanelRegistry } from "@cognia/plugin-contract/lib/context-workbench/panel-registry"
export type { ContextPanelRegistry } from "@cognia/plugin-contract/lib/context-workbench/panel-registry"

function hasEvery(values: readonly string[] | undefined, available: ReadonlySet<string>): boolean {
  return values?.every((value) => available.has(value)) ?? true
}

export function createContextPanelRegistry(): ContextPanelRegistry {
  const definitions = new Map<string, ContextPanelDefinition>()
  const badges = new Map<string, number>()
  const listeners = new Set<() => void>()
  let revision = 0

  const notify = () => {
    revision += 1
    listeners.forEach((listener) => listener())
  }

  const unregister = (panelId: string) => {
    badges.delete(panelId)
    if (!definitions.delete(panelId)) return
    notify()
  }

  return {
    register(definition) {
      if (definitions.has(definition.id)) {
        throw new Error(`Context panel id already registered: ${definition.id}`)
      }
      // The workbench reads badges through the stored definition, so pushed
      // counts have to ride on it rather than live in a second lookup the
      // activity rail would have to know about.
      definitions.set(definition.id, {
        ...definition,
        getBadge: (resource) =>
          (definition.getBadge?.(resource) ?? 0) + (badges.get(definition.id) ?? 0),
      })
      notify()
      return () => unregister(definition.id)
    },
    unregister,
    unregisterPlugin(pluginId) {
      let changed = false
      for (const [id, definition] of definitions) {
        if (definition.pluginId === pluginId) {
          definitions.delete(id)
          badges.delete(id)
          changed = true
        }
      }
      if (changed) notify()
    },
    get: (panelId) => definitions.get(panelId),
    setBadge(panelId, count) {
      if (!definitions.has(panelId)) return false
      const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
      if ((badges.get(panelId) ?? 0) === next) return true
      if (next === 0) badges.delete(panelId)
      else badges.set(panelId, next)
      notify()
      return true
    },
    resolve(resource) {
      const capabilities = new Set(resource.capabilities)
      return [...definitions.values()]
        .filter((definition) => definition.appliesTo(resource))
        .filter((definition) => hasEvery(definition.requiredCapabilities, capabilities))
        .filter((definition) => definition.hasRequiredPermissions?.() ?? true)
        .sort((left, right) => {
          const order = (left.order ?? 100) - (right.order ?? 100)
          return order === 0 ? left.id.localeCompare(right.id) : order
        })
    },
    listActivities() {
      const activities = new Set<string>()
      for (const definition of definitions.values()) {
        activities.add(definition.activity)
      }
      return [...activities]
    },
    listPanels() {
      return [...definitions.values()].map((definition) => ({
        id: definition.id,
        activity: definition.activity,
        labelKey: definition.labelKey,
        label: definition.label,
        pluginId: definition.pluginId,
      }))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getRevision: () => revision,
    refresh: notify,
  }
}

export const contextPanelRegistry = createContextPanelRegistry()
