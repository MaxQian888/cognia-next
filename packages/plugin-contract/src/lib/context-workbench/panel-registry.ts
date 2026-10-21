/**
 * The plugin contract's share of `lib/context-workbench/panel-registry.ts`, which re-exports these.
 */
import type {
  ContextActivity,
  ContextPanelDefinition,
  ContextResource,
} from "../../types/context-workbench"

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
  /**
   * All distinct activity ids contributed by currently-registered panels.
   *
   * Unlike `resolve`, this does not filter by resource or capabilities: it
   * returns the complete set so the customizer can offer all plugin activities
   * for ordering/hiding regardless of which resource is currently in view.
   */
  listActivities: () => string[]
  /**
   * Every registered panel's identity, unfiltered by resource.
   *
   * The panel-level complement of {@link listActivities}, and unfiltered for the
   * same reason: the customizer offers panels for ordering and hiding while no
   * particular resource is in view (it is reachable from Settings), so filtering
   * by the active one would make the list change under the user.
   *
   * Identity only — no renderer, no predicates. A caller that wants to *mount* a
   * panel goes through `resolve`, which applies the capability and permission
   * gates this deliberately skips.
   */
  listPanels: () => Array<{
    id: string
    activity: ContextActivity
    labelKey: string
    label?: string
    pluginId?: string
  }>
  subscribe: (listener: () => void) => () => void
  getRevision: () => number
  refresh: () => void
}
