/**
 * Plugin SDK — `view-container` capability surface.
 *
 * Re-exports the authoring helper and view-container registry for plugin-owned
 * rail/panel destinations, plus the refusal type of the opener.
 *
 * Opening a container is `ctx.ui.openViewContainer(containerId)` (typed on
 * `PluginUIAPI`, re-exported from `@cognia/plugin-sdk/context`). It is the only
 * way to show a `location: "panel"` container, requires `extension:ui`, and
 * only opens the calling plugin's own containers. Its refusals are
 * `ViewContainerOpenError`s — test them with `isViewContainerOpenError`. The
 * host factory behind it is deliberately not re-exported: it takes a plugin id,
 * so handing it to authors would let one plugin open another's containers.
 */

export { defineViewContainer } from "../define/define-view-container"

export {
  registerViewContainer,
  unregisterViewContainersByPlugin,
  getViewContainer,
  getViewContainerSnapshot,
  subscribeViewContainers,
} from "@/lib/plugin/registries/view-container-registry"

export {
  ViewContainerOpenError,
  isViewContainerOpenError,
} from "@/lib/plugin/api/view-container-errors"

export type { ViewContainerEntry } from "@/lib/plugin/registries/view-container-registry"
export type { ViewContainerOpenErrorCode } from "@/lib/plugin/api/view-container-errors"
export type { PluginViewContainerAPI } from "@/lib/plugin/api/view-container-api"
export type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"
