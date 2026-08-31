/**
 * Strix Security Scan — a desktop plugin that runs the Strix autonomous AI
 * penetration-testing CLI and browses the findings.
 *
 * Wiring:
 *  - The panel lives in the RIGHT-hand Context Workbench (`review` activity),
 *    registered imperatively through `ctx.contextPanels.register`. It used to
 *    be a left-rail view container; a scan is something you read beside the
 *    conversation that prompted it, not a destination you navigate away to.
 *  - Registration is imperative for the same reason the views were: the
 *    declarative `manifest.contextPanels[]` path resolves a renderer from a
 *    separate `entry` module, and a bundled `builtin://` plugin has no
 *    fetchable install path to import one from.
 *  - `activate()` bridges `ctx.terminal` + `ctx.dexie` + `ctx.contextPanels`
 *    into a module-level runtime the panel reads.
 *  - `/security` reveals the panel instead of selecting a rail guild.
 *
 * The old container carried `when: "platform.tauri"`. Context panels have no
 * `when` clause, and it was redundant anyway: `runtimeCompatibility` blocks
 * this plugin in the browser and mobile shells at enable time, so it never
 * activates anywhere the gate would have mattered.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"
import { I18N_MESSAGES } from "./i18n"
import { StrixPanel } from "./StrixPanel"
import { PANEL_ID, PLUGIN_ID } from "./ids"
import { clearStrixRuntime, setStrixRuntime } from "./runtime"

let disposePanel: (() => void) | undefined

const definition: PluginDefinition = {
  // Overlay the declarative i18n bundle onto plugin.json so the manager merges
  // it into the host next-intl tree (builtinManifest()). See pet-daily-quests.
  manifest: { ...(manifest as object), i18n: { locales: I18N_MESSAGES } } as never,

  activate: async (ctx: PluginContext) => {
    disposePanel?.()
    disposePanel = undefined

    const dexie = ctx.dexie
    if (dexie) {
      setStrixRuntime({
        terminal: ctx.terminal,
        dexie,
        contextPanels: ctx.contextPanels ?? null,
        securityScans: ctx.securityScans,
      })
    } else {
      ctx.logger?.error?.("strix-security: ctx.dexie unavailable — panel will be inert")
    }

    try {
      disposePanel = ctx.contextPanels?.register({
        id: PANEL_ID,
        activity: "review",
        label: "Security",
        labelKey: `plugin.${PLUGIN_ID}.panel.title`,
        resourceKinds: ["session"],
        icon: "ShieldAlert",
        order: 45,
        // A scan form, a streaming console and a findings list do not fit a
        // 360px column comfortably; the panel still renders there, but this is
        // what it asks for when it first comes forward.
        preferredMode: "wide",
        retention: "stateful",
        renderer: StrixPanel,
      })
    } catch (error) {
      ctx.logger?.error?.(
        `strix-security: context panel not registered — ${error instanceof Error ? error.message : String(error)}`
      )
    }

    ctx.logger?.info?.("strix-security activated")

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "security") return false
        return ctx.contextPanels?.reveal(PANEL_ID, "wide") ?? false
      },
    }
  },

  deactivate: async (ctx?: PluginContext) => {
    disposePanel?.()
    disposePanel = undefined
    clearStrixRuntime()
    ctx?.logger?.info?.("strix-security deactivated")
  },
}

export default definition
