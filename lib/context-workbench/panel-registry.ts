import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"

export interface ContextPanelRegistry {
  register: (definition: ContextPanelDefinition) => () => void
  unregister: (panelId: string) => void
  unregisterPlugin: (pluginId: string) => void
  get: (panelId: string) => ContextPanelDefinition | undefined
  resolve: (
    resource: ContextResource,
    grantedPermissions: ReadonlySet<string>
  ) => ContextPanelDefinition[]
  subscribe: (listener: () => void) => () => void
  getRevision: () => number
  refresh: () => void
}

function hasEvery(values: readonly string[] | undefined, available: ReadonlySet<string>): boolean {
  return values?.every((value) => available.has(value)) ?? true
}

export function createContextPanelRegistry(): ContextPanelRegistry {
  const definitions = new Map<string, ContextPanelDefinition>()
  const listeners = new Set<() => void>()
  let revision = 0

  const notify = () => {
    revision += 1
    listeners.forEach((listener) => listener())
  }

  const unregister = (panelId: string) => {
    if (!definitions.delete(panelId)) return
    notify()
  }

  return {
    register(definition) {
      if (definitions.has(definition.id)) {
        throw new Error(`Context panel id already registered: ${definition.id}`)
      }
      definitions.set(definition.id, definition)
      notify()
      return () => unregister(definition.id)
    },
    unregister,
    unregisterPlugin(pluginId) {
      let changed = false
      for (const [id, definition] of definitions) {
        if (definition.pluginId === pluginId) {
          definitions.delete(id)
          changed = true
        }
      }
      if (changed) notify()
    },
    get: (panelId) => definitions.get(panelId),
    resolve(resource, grantedPermissions) {
      const capabilities = new Set(resource.capabilities)
      return [...definitions.values()]
        .filter((definition) => definition.appliesTo(resource))
        .filter((definition) => hasEvery(definition.requiredCapabilities, capabilities))
        .filter((definition) => hasEvery(definition.requiredPermissions, grantedPermissions))
        .filter((definition) => definition.hasRequiredPermissions?.() ?? true)
        .sort((left, right) => {
          const order = (left.order ?? 100) - (right.order ?? 100)
          return order === 0 ? left.id.localeCompare(right.id) : order
        })
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
