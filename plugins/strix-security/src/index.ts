/**
 * Strix Security Scan — a desktop plugin that runs the Strix autonomous AI
 * penetration-testing CLI from a dedicated rail panel and browses the findings.
 *
 * Wiring:
 *  - The rail container comes from `manifest.viewsContainers` (pure data).
 *  - The React panel is registered imperatively via `registerView(...)` with a
 *    directly-bundled component. The declarative `manifest.views[]` path is not
 *    wired for in-tree `builtin://` plugins (its importer is fetch+eval and
 *    can't load a bundled .tsx / resolve `@/` aliases), so we register the same
 *    `ResolvedPluginView` the bridge would have produced.
 *  - `activate()` bridges `ctx.terminal` + `ctx.dexie` into a module-level
 *    runtime the panel reads (the panel only receives `{pluginId, viewId}`).
 *  - `/security` opens the panel by selecting its rail guild.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import type { FullPluginContext } from "@/lib/plugin/core/context"
import { registerView, unregisterViewsByPlugin } from "@/lib/plugin/registries/tree-view-registry"
import { useUIStore } from "@/stores/ui"
import manifest from "../plugin.json"
import { I18N_MESSAGES } from "./i18n"
import { StrixPanel } from "./StrixPanel"
import { CONTAINER_ID, PLUGIN_ID, VIEW_ID } from "./ids"
import { clearStrixRuntime, setStrixRuntime } from "./runtime"

const CONTAINER_FULL_ID = `${PLUGIN_ID}:${CONTAINER_ID}`

/** Open the panel by selecting its rail guild (mirrors guild-rail.tsx). */
function openPanel(): void {
  useUIStore.getState().setSelectedGuild({ kind: "plugin-view", containerId: CONTAINER_FULL_ID })
}

const definition: PluginDefinition = {
  // Overlay the declarative i18n bundle onto plugin.json so the manager merges
  // it into the host next-intl tree (builtinManifest()). See pet-daily-quests.
  manifest: { ...(manifest as object), i18n: { locales: I18N_MESSAGES } } as never,

  activate: async (ctx: PluginContext) => {
    const full = ctx as FullPluginContext
    const dexie = ctx.dexie
    if (dexie) {
      setStrixRuntime({ terminal: full.terminal, dexie })
    } else {
      ctx.logger?.error?.("strix-security: ctx.dexie unavailable — panel will be inert")
    }

    registerView({
      kind: "react",
      pluginId: ctx.pluginId,
      viewId: VIEW_ID,
      containerId: CONTAINER_FULL_ID,
      component: StrixPanel,
    })

    ctx.logger?.info?.("strix-security activated")

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "security") return false
        openPanel()
        return true
      },
    }
  },

  deactivate: async (ctx?: PluginContext) => {
    const id = ctx?.pluginId ?? PLUGIN_ID
    unregisterViewsByPlugin(id)
    clearStrixRuntime()
    ctx?.logger?.info?.("strix-security deactivated")
  },
}

export default definition
