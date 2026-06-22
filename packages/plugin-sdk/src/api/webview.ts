/**
 * Plugin SDK — `webview` capability surface.
 *
 * Re-exports the webview authoring helper, registry, and message plumbing for
 * sandboxed plugin webviews.
 */

export { defineWebview } from "../define/define-webview"

export {
  registerWebview,
  unregisterWebviewsByPlugin,
  getWebview,
  getWebviewSnapshot,
  listWebviewsForContainer,
  subscribeWebviews,
  attachWebviewPoster,
  postMessageToWebview,
  dispatchWebviewMessage,
  onWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"

export type {
  PluginWebviewDef,
  PluginWebviewHandle,
  PluginWebviewMessage,
  ResolvedPluginWebview,
} from "@/types/plugin/plugin-webview"
