/**
 * Pure link / id helpers shared by the plugin feedback surfaces.
 *
 * A leaf on purpose: `PluginEnableFailureToaster` and `PluginErrorToaster` are
 * mounted in the root layout, and the modules these helpers used to live in
 * (`use-plugin-uninstall`, `use-plugin-enable-action`) statically reach the
 * plugin manager. `PluginRuntimeInitializer` keeps the manager's module graph
 * out of the first paint with a dynamic import; importing a helper must not
 * undo that.
 */

export type PluginDetailSection = "overview" | "capabilities" | "configure" | "permissions" | "data"

/**
 * The deep link every "View details" action uses. `/plugins` resolves it
 * through `usePluginsUrlSync` on both the desktop panel and the phone body.
 */
export function pluginDetailHref(pluginId: string, subtab?: PluginDetailSection): string {
  const params = new URLSearchParams({ plugin: pluginId })
  if (subtab) params.set("subtab", subtab)
  return `/plugins?${params.toString()}`
}

/**
 * The toast id for "enabling this plugin failed with this message". Shared by
 * the panel's own enable feedback and the manager-event toaster, so the two
 * reports of one failure collapse into a single toast.
 */
export function pluginEnableFailureToastId(pluginId: string, message: string): string {
  return `${pluginId}::${message}`
}
