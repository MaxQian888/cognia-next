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
 *    + `ctx.ui` + `ctx.i18n.formatDate` into a module-level runtime the panel
 *    reads.
 *  - `/security` reveals the panel; `/security <target>` also pre-fills the
 *    scan form once one mounts (see `setPendingTarget`).
 *
 * The old container carried `when: "platform.tauri"`. Context panels have no
 * `when` clause, and it was redundant anyway: `runtimeCompatibility` blocks
 * this plugin in the browser and mobile shells at enable time, so it never
 * activates anywhere the gate would have mattered.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { StrixPanel } from "./StrixPanel"
import { PANEL_ID, PLUGIN_ID } from "./ids"
import { markInterruptedRuns } from "./db"
import { abortActiveScan, clearStrixRuntime, setPendingTarget, setStrixRuntime } from "./runtime"

let disposePanel: (() => void) | undefined

// plugin.json is the whole manifest, including the flat-keyed i18n bundle the
// manager prefixes `plugin.strix-security.` on enable.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,

  activate: async (ctx) => {
    disposePanel?.()
    disposePanel = undefined

    const dexie = ctx.dexie ?? null
    setStrixRuntime({
      terminal: ctx.terminal,
      dexie,
      contextPanels: ctx.contextPanels,
      securityScans: ctx.securityScans,
      ui: ctx.ui,
      formatDate: (date, options) => ctx.i18n.formatDate(date, options),
    })

    if (dexie) {
      // A run row left `running` by a previous host lifetime is lying — its
      // PTY is long dead. Reconcile it to `cancelled` so the history and the
      // execution journal stop showing a scan that can never finish. The
      // panel must activate even if IndexedDB is unhappy, so a failure is
      // logged rather than thrown.
      const activatedAt = Date.now()
      void markInterruptedRuns(dexie, {
        cutoff: activatedAt,
        error:
          "Scan was interrupted — the host was closed or the plugin was reloaded before it finished.",
      })
        .then(async (runs) => {
          for (const run of runs) await ctx.securityScans.syncExecutionRun(run)
        })
        .catch((error: unknown) =>
          ctx.logger.warn(
            `strix-security: interrupted-run reconciliation failed — ${error instanceof Error ? error.message : String(error)}`
          )
        )
    } else {
      ctx.logger.error("strix-security: ctx.dexie unavailable — scans are disabled")
    }

    try {
      disposePanel = ctx.contextPanels.register({
        id: PANEL_ID,
        activity: "review",
        label: ctx.i18n.t("panel.title"),
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
      ctx.logger.error(
        `strix-security: context panel not registered — ${error instanceof Error ? error.message : String(error)}`
      )
    }

    ctx.logger.info("strix-security activated")

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration and teardown.
    return {
      onCommand: async (command: string, args?: string[]) => {
        if (command !== "security") return false
        // `/security https://example.com` pre-fills the form's target field;
        // the panel consumes the stash on mount (or its next mount).
        const target = args?.join(" ").trim()
        if (target) setPendingTarget(target)
        return ctx.contextPanels.reveal(PANEL_ID, "wide")
      },
    }
  },

  deactivate: async (ctx) => {
    // An in-flight scan holds a PTY the plugin owns; leaving it running past
    // teardown would orphan the session. The runner records the run as
    // `cancelled` when the abort lands.
    abortActiveScan()
    disposePanel?.()
    disposePanel = undefined
    clearStrixRuntime()
    ctx.logger.info("strix-security deactivated")
  },
})
