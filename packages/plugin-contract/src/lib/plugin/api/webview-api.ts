/**
 * The plugin contract's share of `lib/plugin/api/webview-api.ts`, which re-exports these.
 */
import type { PluginWebviewHandle } from "../../../types/plugin/plugin-webview"

export interface CreateWebviewInput {
  /** Local id (namespaced to the plugin). Auto-generated when omitted. */
  id?: string
  /** Container (B1) local id this webview mounts into. */
  containerId: string
  /** Raw HTML body (wrapped with CSP + polyfill before serving). */
  html: string
  title?: string
  when?: string
}

export interface PluginWebviewAPI {
  create(input: CreateWebviewInput): PluginWebviewHandle
}
