/**
 * Context Inspector — built-in plugin.
 *
 * The reference consumer for DECLARATIVE webview-backed context panels: the
 * manifest overlay below carries two `webviews[]` entries (inline HTML, no
 * entry module — which is exactly why a `builtin://` plugin can use this
 * path) and a `contextPanels[]` entry referencing the first by id. The module
 * registers nothing imperatively; enabling the plugin exercises the whole
 * declarative chain — validation → context-panels bridge → webview bridge →
 * panel registry → workbench render → in-frame RPC.
 *
 * The second webview (`inspector-probe`) exists to be named by an in-frame
 * `api.register({ webview })` call — the panel's "register(probe)" button —
 * so the dynamic-registration arm of the mirrored API is reachable by hand,
 * not just from unit tests.
 *
 * The panel itself is a developer tool: it shows the live active context,
 * workbench state, and this frame's visibility, with controls covering every
 * mirrored method (`setBadge` / `reveal` / `setMode` / `setPinned` /
 * `register` / `dispose`) plus `acquireCogniaWebviewApi().setState` so its
 * counters survive the iframe remount a workbench collapse causes.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import {
  buildInspectorHtml,
  buildProbeHtml,
  INSPECTOR_PANEL_ID,
  PROBE_WEBVIEW_ID,
} from "./inspector-html"

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would silently drop identity fields.
  manifest: {
    ...(manifestJson as object),
    webviews: [
      {
        id: INSPECTOR_PANEL_ID,
        title: "Context Inspector",
        titleKey: "panel.inspector",
        html: buildInspectorHtml(),
      },
      {
        id: PROBE_WEBVIEW_ID,
        title: "Inspector probe",
        titleKey: "panel.probe",
        html: buildProbeHtml(),
      },
    ],
    contextPanels: [
      {
        id: INSPECTOR_PANEL_ID,
        kind: "webview",
        webview: INSPECTOR_PANEL_ID,
        resourceKinds: ["session"],
        activity: "inspect",
        labelKey: "panel.inspector",
        label: "Context Inspector",
        icon: "SearchCode",
        order: 40,
        retention: "stateful",
      },
    ],
  } as never,
  activate: (ctx: PluginContext) => {
    // Both surfaces are declarative; nothing to register here.
    ctx.logger.info("context-inspector activated")
  },
}

export default definition
