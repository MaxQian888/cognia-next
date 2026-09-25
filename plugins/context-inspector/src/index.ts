/**
 * Context Inspector — built-in DEVELOPER plugin.
 *
 * The reference consumer for DECLARATIVE webview-backed context panels: the
 * manifest overlay below carries two `webviews[]` entries (inline HTML, no
 * entry module — which is exactly why a `builtin://` plugin can use this
 * path) and a `contextPanels[]` entry referencing the first by id. Enabling the
 * plugin exercises the whole declarative chain — validation → context-panels
 * bridge → webview bridge → panel registry → workbench render → in-frame RPC.
 *
 * The second webview (`inspector-probe`) exists to be named by an in-frame
 * `api.register({ webview })` call — the panel's "register(probe)" button —
 * so the dynamic-registration arm of the mirrored API is reachable by hand,
 * not just from unit tests.
 *
 * Opt-in: it is a developer tool, so plugin.json declares no
 * `activationEvents` — it stays off until the user enables it on the Plugins
 * page (the SDK exposes no developer-mode signal to gate it on instead), and
 * both the plugin and its panel are labelled "Developer".
 *
 * Localization: a webview document is outside the host's i18n pipeline, so
 * its strings are baked into the HTML. `activate()` captures `ctx.i18n.t`, and
 * each webview's `html` is a getter the webview bridge reads when it
 * registers the frames — which the manager does AFTER `activate()` returns — so
 * the document carries the user's language. Before activation (validation,
 * discovery) the getter falls back to the English bundle. A language switch
 * reaches the frames the next time the plugin is enabled: declarative webview
 * HTML is resolved once per enable by the host.
 *
 * `session:read` is used: the in-frame `getActiveContext()` RPC only returns a
 * `session` resource to a plugin holding that permission.
 */

import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import {
  buildInspectorHtml,
  buildProbeHtml,
  INSPECTOR_PANEL_ID,
  PROBE_WEBVIEW_ID,
  resolveInspectorStrings,
  type InspectorStrings,
} from "./inspector-html"

type Translate = (key: string) => string

const ENGLISH = manifestJson.i18n.locales.en as Record<string, string>
const englishTranslate: Translate = (key) => ENGLISH[key] ?? key

/** `ctx.i18n.t` while the plugin is active; English otherwise. */
let translate: Translate = englishTranslate

/** The frame string table in the current language. */
export function currentInspectorStrings(): InspectorStrings {
  return resolveInspectorStrings(translate)
}

export const manifest = definePluginManifest({
  ...manifestJson,
  webviews: [
    {
      id: INSPECTOR_PANEL_ID,
      title: ENGLISH["panel.inspector"],
      titleKey: "panel.inspector",
      get html() {
        return buildInspectorHtml(currentInspectorStrings())
      },
    },
    {
      id: PROBE_WEBVIEW_ID,
      title: ENGLISH["panel.probe"],
      titleKey: "panel.probe",
      get html() {
        return buildProbeHtml(currentInspectorStrings())
      },
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
      label: ENGLISH["panel.inspector"],
      icon: "SearchCode",
      order: 40,
      retention: "stateful",
    },
  ],
})

const definition = definePlugin({
  manifest,
  activate: (ctx: PluginContext) => {
    // Both surfaces are declarative; activation only supplies the translator
    // the webview HTML getters read when the bridge registers the frames.
    translate = (key) => ctx.i18n.t(key)
    ctx.lifecycle.onDispose(() => {
      translate = englishTranslate
    }, "context-inspector:translator")
    ctx.logger.info("context-inspector activated")
  },
})

export default definition
