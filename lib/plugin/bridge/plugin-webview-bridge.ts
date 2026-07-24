/**
 * Plugin webview bridge (B3).
 *
 * Resolves `manifest.webviews[]` on enable. Each entry's HTML body is taken
 * inline (`html`) or dynamic-imported (`entry`/`export`, a string or
 * `() => string`), then wrapped with a CSP derived from the plugin's
 * `networkAccess.allowedDomains` (`lib/plugin/security/webview-csp.ts`) plus
 * the cognia webview api polyfill. The wrapped `srcDoc` is registered with the
 * webview registry; the B1 container panel renders it in a sandboxed iframe.
 *
 * Mirrors the view-bridge shape so it plugs into MODULE_BRIDGE_CAPABILITIES.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginWebviewDef, ResolvedPluginWebview } from "@/types/plugin/plugin-webview"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import { wrapWebviewHtml } from "@/lib/plugin/security/webview-csp"
import {
  registerWebview,
  unregisterWebviewsByPlugin,
} from "@/lib/plugin/registries/webview-registry"

export interface WebviewBridgeError {
  pluginId: string
  webviewId: string
  message: string
}

export interface WebviewBridgeResult {
  registered: number
  errors: WebviewBridgeError[]
}

export interface WebviewBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<WebviewBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

export async function registerWebviewsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: WebviewBridgeOptions = {}
): Promise<WebviewBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.webviews ?? []
  if (defs.length === 0) return { registered: 0, errors: [] }

  unregisterWebviewsByPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const allowedDomains = manifest.networkAccess?.allowedDomains
  const errors: WebviewBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      // A webview referenced by a context panel gets the mirrored panel API
      // injected. The capability check covers webviews that only BECOME panel
      // bodies later, via an RPC `register({ webview })` — their srcDoc is
      // wrapped once, at enable, so waiting for the reference would be too
      // late. Plugins without the capability keep the minimal surface.
      const contextPanelApi =
        (manifest.contextPanels?.some((panel) => panel.webview === def.id) ?? false) ||
        (manifest.capabilities?.includes("context-panel") ?? false)
      const resolved = await resolveWebview(
        def,
        pluginId,
        installRoot,
        allowedDomains,
        importer,
        contextPanelApi
      )
      registerWebview(resolved)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, webviewId: def.id, message })
      loggers.manager.error(
        `[plugin-webview-bridge] failed to register ${pluginId} webview "${def.id}"`,
        err
      )
    }
  }

  return { registered, errors }
}

async function resolveWebview(
  def: PluginWebviewDef,
  pluginId: string,
  installRoot: string,
  allowedDomains: string[] | undefined,
  importer: NonNullable<WebviewBridgeOptions["importer"]>,
  contextPanelApi: boolean
): Promise<ResolvedPluginWebview> {
  let body: string
  if (typeof def.html === "string") {
    body = def.html
  } else if (def.entry && def.export) {
    const resolvedEntry = resolvePluginPath(installRoot, def.entry)
    const mod = await importer(resolvedEntry)
    const exported = mod[def.export]
    const value = typeof exported === "function" ? (exported as () => unknown)() : exported
    if (typeof value !== "string") {
      throw new Error(`webview "${def.id}" export "${def.export}" did not yield an HTML string`)
    }
    body = value
  } else {
    throw new Error(
      `webview "${def.id}" must declare either inline \`html\` or \`entry\`+\`export\``
    )
  }

  const srcDoc = wrapWebviewHtml(body, { allowedDomains, contextPanelApi })
  return {
    pluginId,
    viewId: def.id,
    containerId: def.containerId ? `${pluginId}:${def.containerId}` : undefined,
    title: def.title,
    when: def.when,
    surface: def.surface ?? "panel",
    srcDoc,
  }
}

export function unregisterWebviewsForPlugin(pluginId: string): void {
  unregisterWebviewsByPlugin(pluginId)
}
