/**
 * Context Inspector — built-in plugin.
 *
 * The reference consumer for DECLARATIVE webview-backed context panels: the
 * manifest overlay below carries a `webviews[]` entry (inline HTML, no entry
 * module — which is exactly why a `builtin://` plugin can use this path) and a
 * `contextPanels[]` entry referencing it by id. The module registers nothing
 * imperatively; enabling the plugin exercises the whole declarative chain —
 * validation → context-panels bridge → webview bridge → panel registry →
 * workbench render → in-frame RPC.
 *
 * The panel itself is a developer tool: it shows the live active context,
 * workbench state, and this frame's visibility, with one button per mirrored
 * write method (`setBadge` / `reveal` / `setMode` / `setPinned`).
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import manifestJson from "../plugin.json"
import { buildInspectorHtml, INSPECTOR_PANEL_ID } from "./inspector-html"

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would silently drop identity fields.
  manifest: {
    ...(manifestJson as object),
    webviews: [
      {
        id: INSPECTOR_PANEL_ID,
        title: "Context Inspector",
        html: buildInspectorHtml(),
      },
    ],
    contextPanels: [
      {
        id: INSPECTOR_PANEL_ID,
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
    ctx.logger?.info("context-inspector activated")
  },
}

export default definition
