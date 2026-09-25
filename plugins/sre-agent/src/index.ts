import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { PANEL_ACTIVITY, PANEL_ID, PLUGIN_ID } from "./ids"
import { createSreTools } from "./tools"
import { createSreRuntime } from "./runtime"
import { clearSrePanelRuntime, setSrePanelRuntime } from "./panel-runtime"
import { IncidentPanel } from "./panel/incident-panel"

let lifecycleController: AbortController | undefined
let disposePanel: (() => void) | undefined

/**
 * plugin.json is the whole manifest — tools, subagent, Dexie table and the
 * i18n bundle (flat keys; the manager prefixes `plugin.sre-agent.`).
 *
 * Demo, and opt-in: the only evidence backend is the bundled demo corpus
 * (`SreProviderKind` `"fixture"`), so the plugin declares no `startup`
 * activation — it runs only for someone who enabled it — and every tool
 * description, result and the panel say "demo corpus".
 */
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    lifecycleController?.abort()
    lifecycleController = new AbortController()
    disposePanel?.()
    disposePanel = undefined

    // One runtime for the tools AND the panel. Two would mean two evidence
    // pools, and `sre_validate_timeline` resolves cited ids against the pool
    // it owns — a row citing what the panel pinned would come back
    // `row.evidence_unknown` purely because the agent queried elsewhere.
    const runtime = createSreRuntime()
    setSrePanelRuntime({
      runtime,
      dexie: ctx.dexie ?? null,
      contextPanels: ctx.contextPanels,
      confirm: (options) => ctx.ui.showConfirmDialog(options),
    })

    for (const tool of createSreTools(runtime, lifecycleController.signal)) {
      ctx.agent.registerTool(tool)
    }

    try {
      disposePanel = ctx.contextPanels.register({
        id: PANEL_ID,
        activity: PANEL_ACTIVITY,
        label: ctx.i18n.t("panel.title"),
        labelKey: `plugin.${PLUGIN_ID}.panel.title`,
        resourceKinds: ["session"],
        icon: "Radar",
        // Sole panel in its own activity, so this only orders it against a
        // future sibling — it does not affect where the rail button sits.
        order: 10,
        preferredMode: "narrow",
        retention: "stateful",
        renderer: IncidentPanel,
      })
    } catch (error) {
      // Registration throws when `extension:ui` / `session:read` were not
      // granted. The tools still work, so this degrades the plugin instead of
      // failing the whole activation — but it is never silent.
      ctx.logger.error(
        `sre-agent: context panel not registered — ${error instanceof Error ? error.message : String(error)}`
      )
    }

    ctx.logger.info("sre-agent plugin activated (demo corpus)")
  },
  deactivate: async () => {
    lifecycleController?.abort()
    lifecycleController = undefined
    disposePanel?.()
    disposePanel = undefined
    clearSrePanelRuntime()
  },
})
