/**
 * The plugin contract's share of `lib/plugin/api/view-container-api.ts`, which re-exports these.
 */

export interface PluginViewContainerAPI {
  /**
   * Show one of this plugin's view containers — `rail` or `panel` — in the
   * shell's middle column. Accepts the local id from `viewsContainers[].id` or
   * the namespaced `<pluginId>:<id>`. Requires `extension:ui`. Rejects with a
   * `PermissionError` without that grant, and with a `ViewContainerOpenError`
   * for an empty id (`invalid-id`), an id nothing registered
   * (`not-registered`), or another plugin's container (`foreign`).
   */
  openViewContainer: (containerId: string) => Promise<void>
}
