/**
 * `ctx.webview` — imperative sandboxed-webview API (B3).
 *
 * A plugin can create an ad-hoc webview (rendered in a view container's panel)
 * and exchange postMessage traffic with it. HTML is wrapped with a CSP derived
 * from the plugin's `networkAccess` allowlist (same clamp as `ctx.network`),
 * served into an `<iframe sandbox="allow-scripts">` (no `allow-same-origin`).
 *
 * Declarative `manifest.webviews[]` cover the static case; this API is for
 * webviews a plugin opens at runtime. Both share the webview registry, so the
 * container panel renders either identically.
 */

import { nanoid } from "nanoid"
import type {
  PluginWebviewHandle,
  PluginWebviewMessage,
  ResolvedPluginWebview,
} from "@/types/plugin/plugin-webview"
import { wrapWebviewHtml } from "@/lib/plugin/security/webview-csp"
import {
  registerWebview,
  postMessageToWebview,
  onWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"

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

/** `manifest.networkAccess` subset the CSP builder needs. */
interface NetworkAccess {
  allowedDomains?: string[]
}

export function createWebviewAPI(
  pluginId: string,
  networkAccess: NetworkAccess | undefined
): PluginWebviewAPI {
  return {
    create(input) {
      const viewId = input.id ?? `wv-${nanoid(8)}`
      const fullId = `${pluginId}:${viewId}`
      const resolved: ResolvedPluginWebview = {
        pluginId,
        viewId,
        containerId: `${pluginId}:${input.containerId}`,
        title: input.title,
        when: input.when,
        surface: "panel",
        srcDoc: wrapWebviewHtml(input.html, { allowedDomains: networkAccess?.allowedDomains }),
      }
      const dispose = registerWebview(resolved)
      return {
        id: fullId,
        postMessage: (data: unknown) => postMessageToWebview(fullId, data),
        onMessage: (listener: (m: PluginWebviewMessage) => void) =>
          onWebviewMessage(fullId, listener),
        dispose,
      }
    },
  }
}
