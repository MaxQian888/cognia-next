import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { I18N_MESSAGES } from "./i18n"
import { PANEL_ACTIVITY, PANEL_ID, PLUGIN_ID } from "./ids"
import { createSreTools } from "./tools"
import { createSreRuntime, type SrePluginContext } from "./runtime"
import { clearSrePanelRuntime, setSrePanelRuntime } from "./panel-runtime"
import { IncidentPanel } from "./panel/incident-panel"

let lifecycleController: AbortController | undefined
let disposePanel: (() => void) | undefined

export const manifest: PluginManifest = {
  ...(manifestJson as unknown as PluginManifest),
  id: PLUGIN_ID,
}

/**
 * Manifest handed to the plugin manager.
 *
 * The i18n bundle is overlaid here rather than duplicated into `plugin.json`:
 * `i18n` is not a parity-checked contribution field, and keeping ~120 strings
 * in TypeScript is what lets `i18n.test.ts` prove en/zh parity at build time.
 */
const activationManifest = {
  ...(manifestJson as unknown as PluginManifest),
  id: PLUGIN_ID,
  i18n: { locales: I18N_MESSAGES },
} as PluginManifest

const definition: PluginDefinition = {
  manifest: activationManifest,
  activate: async (ctx: PluginContext) => {
    lifecycleController?.abort()
    lifecycleController = new AbortController()
    disposePanel?.()
    disposePanel = undefined

    // One runtime for the tools AND the panel. Two would mean two evidence
    // pools, and `sre_validate_timeline` resolves cited ids against the pool
    // it owns — a row citing what the panel pinned would come back
    // `row.evidence_unknown` purely because the agent queried elsewhere.
    const runtime = createSreRuntime(ctx as unknown as SrePluginContext)
    setSrePanelRuntime({
      runtime,
      dexie: ctx.dexie ?? null,
      contextPanels: ctx.contextPanels ?? null,
    })

    for (const tool of createSreTools(
      ctx as unknown as SrePluginContext,
      lifecycleController.signal,
      runtime
    )) {
      ctx.agent.registerTool(tool)
    }

    try {
      disposePanel = ctx.contextPanels?.register({
        id: PANEL_ID,
        activity: PANEL_ACTIVITY,
        label: "SRE incidents",
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
      ctx.logger?.error?.(
        `sre-agent: context panel not registered — ${error instanceof Error ? error.message : String(error)}`
      )
    }

    ctx.logger?.info("sre-agent plugin activated")
  },
  deactivate: async () => {
    lifecycleController?.abort()
    lifecycleController = undefined
    disposePanel?.()
    disposePanel = undefined
    clearSrePanelRuntime()
  },
}

export default definition
