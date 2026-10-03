/**
 * Renderer side of `vscode.env`'s clipboard and links, and of
 * `window.registerUriHandler`.
 *
 *   - `env:clipboardReadText` / `env:clipboardWriteText` need the extension's
 *     `clipboard:read` / `clipboard:write` permission.
 *   - `env:openExternal`: a web or mail link opens in the user's browser once
 *     they agree (they may copy it instead); an app link goes to the extension
 *     it names; a file opens in its default app when the extension may run
 *     programs (`shell:execute`). Anything else is refused and logged.
 *   - `env:asExternalUri`: web links are reachable as they are. An app link,
 *     `cognia://<extension id>/<path>` as VS Code extensions build it from
 *     `env.uriScheme`, becomes the plugin deep link
 *     `cognia://plugin/<extension id>/<path>`: the operating system routes that
 *     back here on the desktop, and in a browser it is wrapped in the app's
 *     `/deep-link` page.
 *   - `window:registerUriHandler`: deep links addressed to the extension reach
 *     its handler as `cognia://<extension id>/<path>?<query>#<fragment>`, the
 *     shape VS Code gives (`authority` is the extension id).
 */

import { fileUriToPath } from "@/lib/files/path-uri"
import { isTauri } from "@/lib/platform/detect"
import { listPluginPermissions } from "@/lib/plugin/core/transport"
import type { ParsedDeepLink } from "@/lib/plugin/uri/parse-deep-link"
import { registerUriHandler } from "@/lib/plugin/uri/uri-handler-registry"

import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"

/** `env.uriScheme` in the extension host. */
export const APP_URI_SCHEME = "cognia"

/** What the user chose when an extension asked to open a link. */
export type OpenExternalChoice = "open" | "copy" | null

export interface VscodeEnvDependencies {
  permissions(pluginId: string): Promise<readonly string[]>
  /** The clipboard's text; `null` when it cannot be read. */
  readClipboard(): Promise<string | null>
  writeClipboard(text: string): Promise<void>
  /** Ask the user whether to open `url` for the extension. */
  confirmOpenExternal(pluginId: string, url: string): Promise<OpenExternalChoice>
  openUrl(url: string): Promise<void>
  openPath(path: string): Promise<void>
  /** Deliver a plugin deep link; false when no plugin handles it. */
  routeDeepLink(link: string): Promise<boolean>
  /** The plugin deep link as the user's system opens it. */
  externalDeepLink(link: string): string
  registerUriHandler(pluginId: string, handler: (uri: ParsedDeepLink) => Promise<void>): () => void
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
}

export function createVscodeEnvDependencies(input: {
  confirmOpenExternal: VscodeEnvDependencies["confirmOpenExternal"]
  sendToHost: VscodeEnvDependencies["sendToHost"]
}): VscodeEnvDependencies {
  return {
    ...input,
    permissions: (pluginId) => listPluginPermissions(pluginId),
    readClipboard: async () => (await import("@/lib/tauri/clipboard")).readClipboardText(),
    writeClipboard: async (text) =>
      (await import("@/lib/tauri/clipboard")).writeClipboardText(text),
    openUrl: async (url) => (await import("@/lib/tauri/opener")).openExternal(url),
    openPath: async (path) => (await import("@/lib/tauri/opener")).openPath(path),
    routeDeepLink: async (link) =>
      (await import("@/lib/plugin/uri/route-deep-link")).routePluginDeepLink(link),
    externalDeepLink: (link) => webDeepLink(link),
    registerUriHandler: (pluginId, handler) => registerUriHandler(pluginId, handler),
  }
}

/**
 * The desktop registers the `cognia:` scheme with the operating system; a
 * browser cannot, so there the link goes through the `/deep-link` page.
 */
function webDeepLink(link: string): string {
  if (isTauri() || typeof window === "undefined") return link
  return `${window.location.origin}/deep-link?u=${encodeURIComponent(link)}`
}

let deps: VscodeEnvDependencies | null = null
/** Per extension, the disposer of its URI handler. */
const uriHandlers = new Map<string, () => void>()

export function configureVscodeEnv(next: VscodeEnvDependencies | null): void {
  deps = next
}

function requireDeps(): VscodeEnvDependencies {
  if (!deps) throw new Error("VS Code env is not available yet")
  return deps
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  const value = payload as Record<string, unknown>
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== "string" || !result) {
    throw new Error(`VS Code RPC payload requires non-empty ${field}`)
  }
  return result
}

async function requirePermission(pluginId: string, permission: string): Promise<void> {
  const granted = await requireDeps().permissions(pluginId)
  if (!granted.includes(permission)) {
    throw new Error(`VS Code extension ${pluginId} requires permission ${permission}`)
  }
}

function schemeOf(uri: string): string {
  const match = /^([a-zA-Z][\w+.-]*):/.exec(uri)
  return match ? match[1].toLowerCase() : ""
}

function log(pluginId: string, level: "info" | "warn", message: string): void {
  appendVscodeLog(pluginId, { level, kind: "env", message })
}

const APP_LINK = /^(?:web\+)?cognia:\/\/([^/?#]*)(.*)$/is

/**
 * `cognia://<extension id>/<path>` → `cognia://plugin/<extension id>/<path>`.
 * A link that already is a plugin deep link is kept.
 */
export function toPluginDeepLink(link: string): string {
  const match = APP_LINK.exec(link)
  const authority = match?.[1] ?? ""
  if (!match || !authority) {
    throw new Error(
      `${link} names no extension: app links look like ${APP_URI_SCHEME}://<extension id>/<path>`
    )
  }
  if (authority.toLowerCase() === "plugin") return link.replace(/^web\+/i, "")
  return `${APP_URI_SCHEME}://plugin/${authority}${match[2]}`
}

/** A plugin deep link as VS Code hands it to a URI handler: the extension id as the authority. */
export function toExtensionUri(link: ParsedDeepLink): string {
  const rest = link.raw.replace(/^(?:web\+)?cognia:\/\/plugin\/[^/?#]*/i, "")
  return `${APP_URI_SCHEME}://${link.pluginId}${rest}`
}

async function openExternal(pluginId: string, target: string): Promise<boolean> {
  const scheme = schemeOf(target)
  const d = requireDeps()
  switch (scheme) {
    case "http":
    case "https":
    case "mailto": {
      const choice = await d.confirmOpenExternal(pluginId, target)
      if (choice === "open") {
        await d.openUrl(target)
        return true
      }
      if (choice === "copy") await d.writeClipboard(target)
      return false
    }
    case APP_URI_SCHEME:
    case `web+${APP_URI_SCHEME}`: {
      const routed = await d.routeDeepLink(toPluginDeepLink(target))
      if (!routed) log(pluginId, "warn", `No extension handles ${target}`)
      return routed
    }
    case "file": {
      await requirePermission(pluginId, "shell:execute")
      const path = fileUriToPath(target)
      if (!path) throw new Error(`${target} is not a file path`)
      await d.openPath(path)
      return true
    }
    default:
      log(
        pluginId,
        "warn",
        `openExternal does not open ${scheme || "scheme-less"} links: ${target}`
      )
      return false
  }
}

function asExternalUri(target: string): string {
  const scheme = schemeOf(target)
  if (scheme === "http" || scheme === "https") return target
  if (scheme === APP_URI_SCHEME) return requireDeps().externalDeepLink(toPluginDeepLink(target))
  throw new Error(
    `asExternalUri takes http, https and ${APP_URI_SCHEME} URIs, not ${scheme || "scheme-less"} ones`
  )
}

function disposeUriHandler(pluginId: string): void {
  const dispose = uriHandlers.get(pluginId)
  if (!dispose) return
  uriHandlers.delete(pluginId)
  dispose()
}

export function installVscodeEnvHandlers(): Array<() => void> {
  return [
    registerMethod("env:clipboardReadText", async (payload, context) => {
      owned(payload, context)
      await requirePermission(context.pluginId, "clipboard:read")
      return (await requireDeps().readClipboard()) ?? ""
    }),
    registerMethod("env:clipboardWriteText", async (payload, context) => {
      const value = owned(payload, context)
      if (typeof value.text !== "string") throw new Error("env:clipboardWriteText needs text")
      await requirePermission(context.pluginId, "clipboard:write")
      await requireDeps().writeClipboard(value.text)
      return null
    }),
    registerMethod("env:openExternal", async (payload, context) => {
      const value = owned(payload, context)
      return openExternal(context.pluginId, requiredString(value, "target"))
    }),
    registerMethod("env:asExternalUri", (payload, context) => {
      const value = owned(payload, context)
      return asExternalUri(requiredString(value, "target"))
    }),
    registerMethod("window:registerUriHandler", (payload, context) => {
      const value = owned(payload, context)
      const token = requiredString(value, "token")
      const { pluginId } = context
      const d = requireDeps()
      disposeUriHandler(pluginId)
      uriHandlers.set(
        pluginId,
        d.registerUriHandler(pluginId, async (link) => {
          await d.sendToHost(pluginId, "extension:call", {
            extensionId: pluginId,
            token,
            method: "handleUri",
            payload: toExtensionUri(link),
          })
        })
      )
      return null
    }),
    registerMethod("window:unregisterUriHandler", (payload, context) => {
      owned(payload, context)
      disposeUriHandler(context.pluginId)
      return null
    }),
  ]
}

/** Drop what a stopped extension registered. */
export function clearVscodeEnvForPlugin(pluginId: string): void {
  disposeUriHandler(pluginId)
}

export function __resetVscodeEnvForTesting(): void {
  for (const dispose of uriHandlers.values()) dispose()
  uriHandlers.clear()
  deps = null
}
