/**
 * Plugin SDK helper for sandboxed webviews (B3).
 *
 * Pure typesafety pass-through — wrapping a webview in `defineWebview()` gives
 * plugin authors autocomplete and a compile-time check against
 * `PluginWebviewDef`.
 *
 * Usage:
 *   const dashboard = defineWebview({
 *     id: "dashboard",
 *     containerId: "explorer",
 *     title: "Dashboard",
 *     html: "<h1>Hello</h1><script>const api = acquireCogniaWebviewApi()</script>",
 *   })
 */

import type { PluginWebviewDef } from "@/types/plugin/plugin-webview"

export function defineWebview(webview: PluginWebviewDef): PluginWebviewDef {
  return webview
}
