/**
 * Opening a plugin view container — `ctx.ui.openViewContainer(containerId)`
 * and the host's own "Open" affordances.
 *
 * A view container (`manifest.viewsContainers[]`, B1) is shown by selecting the
 * `plugin-view` guild and routing to `/`, where the desktop channel list swaps
 * its middle column to `components/shell/plugin-view-container-panel.tsx`.
 * The rail does that for `location: "rail"` containers through
 * `useShellNav().switchToViewContainer`. A `location: "panel"` container has no
 * rail button by design, so before this module nothing could ever open it.
 *
 * Two entry points share one opener (`showViewContainer`):
 *
 * - `createViewContainerAPI(pluginId)` backs `ctx.ui.openViewContainer`. It is
 *   permission-guarded (`extension:ui`, via `createGuardedAPI`) and a plugin
 *   may only open a container IT registered — naming another plugin's
 *   container is refused, so one plugin cannot yank the shell to another's
 *   surface. The route change travels through `requestPluginNavigation`, the
 *   same seam `ctx.ui.navigate` uses (plugin code has no host router).
 * - Host UI (the plugin detail "Contributed" tab) calls `showViewContainer`
 *   directly with its own router.
 *
 * Both work for `rail` and `panel` containers alike.
 */

import { createPluginSystemLogger } from "../core/logger"
import {
  getViewContainer,
  type ViewContainerEntry,
} from "@/lib/plugin/registries/view-container-registry"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { useUIStore } from "@/stores/ui"
import { requestPluginNavigation } from "./navigation-request"
import { ViewContainerOpenError } from "./view-container-errors"

export {
  ViewContainerOpenError,
  isViewContainerOpenError,
  type ViewContainerOpenErrorCode,
} from "./view-container-errors"

/** The route whose shell renders the selected guild's middle column. */
export const VIEW_CONTAINER_HOST_ROUTE = "/"

/**
 * Select a registered container's `plugin-view` guild and route to the page
 * that renders it. `fullId` is the namespaced registry id
 * (`<pluginId>:<localId>`). Throws `ViewContainerOpenError("not-registered")`
 * — and changes nothing — when no such container is registered (e.g. its
 * plugin was disabled after the caller rendered).
 */
export function showViewContainer(
  fullId: string,
  navigate: (href: string) => void
): ViewContainerEntry {
  const entry = getViewContainer(fullId)
  if (!entry) {
    throw new ViewContainerOpenError(
      "not-registered",
      fullId,
      `View container "${fullId}" is not registered`
    )
  }
  useUIStore.getState().setSelectedGuild({ kind: "plugin-view", containerId: entry.fullId })
  navigate(VIEW_CONTAINER_HOST_ROUTE)
  return entry
}

/**
 * Resolve the container `pluginId` asked for, accepting either its local id
 * (`"explorer"`, as declared in `viewsContainers[].id`) or its namespaced id
 * (`"<pluginId>:explorer"`).
 *
 * The plugin's own namespace is tried first, so a local id that happens to
 * look like another plugin's full id still resolves to the caller's own
 * container. Only when nothing of the caller's matches is the id checked
 * against the rest of the registry, to tell "someone else's" apart from
 * "does not exist".
 */
export function resolveOwnViewContainer(pluginId: string, containerId: string): ViewContainerEntry {
  if (typeof containerId !== "string" || containerId.trim().length === 0) {
    throw new ViewContainerOpenError(
      "invalid-id",
      String(containerId),
      "openViewContainer requires a non-empty container id"
    )
  }
  const local = getViewContainer(`${pluginId}:${containerId}`)
  if (local && local.pluginId === pluginId) return local

  const direct = getViewContainer(containerId)
  if (direct) {
    if (direct.pluginId === pluginId) return direct
    throw new ViewContainerOpenError(
      "foreign",
      containerId,
      `Plugin "${pluginId}" cannot open view container "${containerId}": it belongs to plugin "${direct.pluginId}"`
    )
  }

  throw new ViewContainerOpenError(
    "not-registered",
    containerId,
    `Plugin "${pluginId}" has no registered view container "${containerId}"`
  )
}

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

export function createViewContainerAPI(pluginId: string): PluginViewContainerAPI {
  const logger = createPluginSystemLogger(pluginId)
  const guarded = createGuardedAPI(
    pluginId,
    {
      openViewContainer: (containerId: string): void => {
        const entry = resolveOwnViewContainer(pluginId, containerId)
        showViewContainer(entry.fullId, (href) => {
          requestPluginNavigation(pluginId, href)
        })
        logger.info(`[view-container] opened ${entry.fullId}`)
      },
    },
    { openViewContainer: "extension:ui" }
  )
  return {
    // `async` so every refusal — including the guard's synchronous
    // PermissionError — reaches the caller as a rejection, never a throw.
    openViewContainer: async (containerId) => {
      await guarded.openViewContainer(containerId)
    },
  }
}
