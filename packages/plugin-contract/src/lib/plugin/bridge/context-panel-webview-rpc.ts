/**
 * The plugin contract's share of `lib/plugin/bridge/context-panel-webview-rpc.ts`, which re-exports these.
 */
import type { PluginContextPanelRegistration } from "../api/context-panel-api"

/**
 * `register` over the wire: the imperative registration minus every function
 * field, plus a `webview` naming another of the plugin's declared webviews to
 * render the new panel's body.
 */
export type ContextPanelWebviewRpcRegistration = Omit<
  PluginContextPanelRegistration,
  "renderer" | "getBadge" | "onFirstActivate" | "onRestore"
> & { webview: string }
