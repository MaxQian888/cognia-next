/**
 * Plugin SDK — `view-container` capability surface.
 *
 * Re-exports the authoring helper and view-container registry for plugin-owned
 * rail/panel destinations.
 */

export { defineViewContainer } from "../define/define-view-container"

export {
  registerViewContainer,
  unregisterViewContainersByPlugin,
  getViewContainer,
  getViewContainerSnapshot,
  subscribeViewContainers,
} from "@/lib/plugin/registries/view-container-registry"

export type { ViewContainerEntry } from "@/lib/plugin/registries/view-container-registry"
export type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"
