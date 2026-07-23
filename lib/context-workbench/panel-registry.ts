import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"

export interface ContextPanelRegistry {
  register: (definition: ContextPanelDefinition) => () => void
  unregister: (panelId: string) => void
  unregisterPlugin: (pluginId: string) => void
  get: (panelId: string) => ContextPanelDefinition | undefined
  /**
   * Push a badge count onto an already-registered panel. `getBadge` is captured
   * at registration time, so a contributor whose count changes later (an
   * unread counter, a queued job) has no other way to surface it. Returns false
   * when the panel is not registered. Counts are additive with any `getBadge`
   * the definition brought itself.
   */
  setBadge: (panelId: string, count: number) => boolean
  /**
   * Panels that apply to `resource` and clear their capability and permission
   * gates, in rail order.
   *
   * Permissions are *not* passed in. They used to be, as one flat
   * `ReadonlySet<string>` supplied by the host — a shape that cannot express
   * per-plugin grants (the real store is `Map<pluginId, Set<permission>>`), so
   * every one of the eight mount sites correctly omitted it and any panel
   * declaring `requiredPermissions` was silently filtered out forever. The
   * registry can't read the permission store directly either: `permission-api`
   * already imports this module to call `refresh()`. So the check is inverted —
   * whoever registers the panel, and therefore already holds both its
   * `pluginId` and `permission-api`, injects `hasRequiredPermissions`.
   */
  resolve: (resource: ContextResource) => ContextPanelDefinition[]
  subscribe: (listener: () => void) => () => void
  getRevision: () => number
  refresh: () => void
}

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
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getRevision: () => revision,
    refresh: notify,
  }
}

export const contextPanelRegistry = createContextPanelRegistry()
