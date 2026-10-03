/**
 * Renderer side of VS Code extensions' webviews.
 *
 * The extension host creates panels (`window:createWebviewPanel`) and
 * registers view providers (`window:registerWebviewViewProvider`); both
 * become tabs in the extension rail (`webview-bridge.ts`). A view's provider
 * is asked to fill it (`resolveWebviewView`) the first time its tab is shown.
 * The host then sets html, options and titles (`webview:update`), posts
 * messages, reveals and disposes.
 *
 * Each tab's frame (`components/extensions/vscode-webview-frame.tsx`) is
 * driven from here: `prepareWebviewFrame` turns the webview's HTML into the
 * frame's document (`webview-document.ts`), and `connectWebviewFrame` speaks
 * the shell's envelopes: it hands over the scripts and saved state once the
 * shell is ready, holds the extension's messages until the scripts have run,
 * forwards the page's messages and saved state, reads resources through the
 * host, and opens links: web, mail and app links as `env.openExternal` does,
 * `command:` links when the webview's `enableCommandUris` allows that command.
 *
 * The host learns when a tab is shown or hidden (`webview:viewState`) and
 * when the user closes a panel (`webview:disposed`).
 */

import { executeCommandWithOptions } from "@/lib/plugin/commands/registry"

import { openExternal } from "./env-handlers"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"
import {
  addWebview,
  attachWebviewFrame,
  DEFAULT_WEBVIEW_OPTIONS,
  getSelectedWebview,
  getWebview,
  listWebviews,
  postToWebview,
  removeWebview,
  selectWebview,
  setWebviewState,
  subscribeWebviews,
  updateWebview,
  type VscodeWebviewOptions,
} from "./webview-bridge"
import {
  bytesToBase64,
  prepareWebviewDocument,
  type WebviewResource,
  type WebviewScript,
} from "./webview-document"
import { readAppTheme, type VscodeThemeKind } from "./webview-theme"

/** Where the frame loads its shell from: the app's own origin. */
export const WEBVIEW_SHELL_PATH = "/vscode-webview/webview-shell.js"

const MARK = "__vscodeWebview"

export interface VscodeWebviewDependencies {
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
  /** Open a link for the extension, as `env.openExternal` does. */
  openLink(pluginId: string, href: string): Promise<boolean>
  executeCommand(command: string, args: unknown[]): Promise<unknown>
  /** The app's theme, as webview CSS variables and body class. */
  theme(): { css: string; kind: VscodeThemeKind }
  /** The app's origin, which serves the shell. */
  origin(): string
}

export function createVscodeWebviewDependencies(input: {
  sendToHost: VscodeWebviewDependencies["sendToHost"]
}): VscodeWebviewDependencies {
  return {
    ...input,
    openLink: (pluginId, href) => openExternal(pluginId, href),
    executeCommand: (command, args) =>
      executeCommandWithOptions(command, { origin: "user" }, ...args),
    theme: () => readAppTheme(),
    origin: () => window.location.origin,
  }
}

let deps: VscodeWebviewDependencies | null = null
let stopResolving: (() => void) | null = null
/** Per webview, the visibility the host was last told. */
const reportedVisible = new Map<string, boolean>()

function requireDeps(): VscodeWebviewDependencies {
  if (!deps) throw new Error("VS Code webviews are not available yet")
  return deps
}

export function configureVscodeWebviews(next: VscodeWebviewDependencies | null): void {
  stopResolving?.()
  stopResolving = null
  deps = next
  if (next) {
    stopResolving = subscribeWebviews(resolveSelectedView)
    resolveSelectedView()
  }
}

function log(pluginId: string, level: "info" | "warn", message: string): void {
  appendVscodeLog(pluginId, { level, kind: "webview", message })
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

/** The webview `handle` names, if it is the calling extension's. */
function ownWebview(value: Record<string, unknown>, context: RpcContext) {
  const handle = requiredString(value, "handle")
  const webview = getWebview(handle)
  if (!webview || webview.pluginId !== context.pluginId) {
    throw new Error(`Webview ${handle} is gone`)
  }
  return webview
}

export function webviewOptionsOf(value: unknown): VscodeWebviewOptions {
  const options = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  const commandUris = options.enableCommandUris
  return {
    enableScripts: options.enableScripts === true,
    enableForms: options.enableForms === true,
    enableCommandUris: Array.isArray(commandUris)
      ? commandUris.filter((command): command is string => typeof command === "string")
      : commandUris === true,
    ...(Array.isArray(options.localResourceRoots)
      ? { localResourceRoots: options.localResourceRoots.map(String) }
      : {}),
    retainContextWhenHidden: options.retainContextWhenHidden === true,
  }
}

/** Ask a view's provider to fill it, the first time its tab is shown. */
function resolveSelectedView(): void {
  const d = deps
  const handle = getSelectedWebview()
  const view = handle ? getWebview(handle) : undefined
  if (!d || !view || view.kind !== "view" || view.resolved || !view.token) return
  updateWebview(view.handle, { resolved: true })
  void d
    .sendToHost(view.pluginId, "extension:call", {
      extensionId: view.pluginId,
      token: view.token,
      method: "resolveWebviewView",
      payload: { handle: view.handle, title: view.title, state: view.state },
    })
    .catch((error: unknown) => {
      log(
        view.pluginId,
        "warn",
        `The ${view.viewType} view could not be resolved: ${error instanceof Error ? error.message : String(error)}`
      )
    })
}

function report(pluginId: string, method: string, payload: Record<string, unknown>): void {
  void requireDeps()
    .sendToHost(pluginId, method, payload)
    .catch(() => {
      // The host has gone; it has nothing left to tell.
    })
}

/** A tab became visible or hidden; tell the host when that changed. */
export function reportWebviewVisibility(handle: string, visible: boolean): void {
  const webview = getWebview(handle)
  if (!webview || !deps) return
  if (reportedVisible.get(handle) === visible) return
  reportedVisible.set(handle, visible)
  report(webview.pluginId, "webview:viewState", { handle, visible, active: visible })
}

/** The user closed a panel's tab. */
export function closeWebview(handle: string): void {
  const removed = removeWebview(handle)
  reportedVisible.delete(handle)
  if (removed && deps) report(removed.pluginId, "webview:disposed", { handle })
}

export interface PreparedWebviewFrame {
  srcDoc: string
  /** The iframe's `sandbox`: scripts and forms only as the webview's options allow. */
  sandbox: string
  scripts: WebviewScript[]
  baseUrl?: string
}

function readResourceThroughHost(pluginId: string, handle: string) {
  return async (url: string): Promise<WebviewResource> => {
    const result = (await requireDeps().sendToHost(pluginId, "webview:resource", {
      handle,
      uri: url,
    })) as { data?: unknown; mime?: unknown } | null
    if (!result || typeof result.data !== "string") throw new Error(`${url} could not be read`)
    const binary = atob(result.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return {
      bytes,
      mime: typeof result.mime === "string" ? result.mime : "application/octet-stream",
    }
  }
}

/** The frame's document for the webview as it is now. */
export async function prepareWebviewFrame(handle: string): Promise<PreparedWebviewFrame> {
  const webview = getWebview(handle)
  if (!webview) throw new Error(`Webview ${handle} is gone`)
  const d = requireDeps()
  const theme = d.theme()
  const prepared = await prepareWebviewDocument({
    html: webview.html,
    enableScripts: webview.options.enableScripts,
    shellUrl: `${d.origin()}${WEBVIEW_SHELL_PATH}`,
    shellOrigin: d.origin(),
    readResource: readResourceThroughHost(webview.pluginId, handle),
    themeCss: theme.css,
    themeKind: theme.kind,
  })
  for (const warning of prepared.warnings) log(webview.pluginId, "warn", warning)
  const sandbox = [
    ...(webview.options.enableScripts ? ["allow-scripts"] : []),
    ...(webview.options.enableForms ? ["allow-forms"] : []),
  ].join(" ")
  return {
    srcDoc: prepared.srcDoc,
    sandbox,
    scripts: prepared.scripts,
    ...(prepared.baseUrl ? { baseUrl: prepared.baseUrl } : {}),
  }
}

/** `command:id?args`, args being JSON (an array, or one argument). */
export function parseCommandUri(href: string): { command: string; args: unknown[] } | undefined {
  const match = /^command:([^?#]+)(?:\?([^#]*))?/i.exec(href)
  if (!match) return undefined
  const command = decodeURIComponent(match[1])
  if (!match[2]) return { command, args: [] }
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match[2]))
    return { command, args: Array.isArray(parsed) ? parsed : [parsed] }
  } catch {
    return { command, args: [] }
  }
}

async function openWebviewLink(handle: string, href: string): Promise<void> {
  const webview = getWebview(handle)
  if (!webview) return
  const d = requireDeps()
  const command = parseCommandUri(href)
  if (!command) {
    await d.openLink(webview.pluginId, href)
    return
  }
  const allowed = webview.options.enableCommandUris
  if (allowed === true || (Array.isArray(allowed) && allowed.includes(command.command))) {
    await d.executeCommand(command.command, command.args)
    return
  }
  log(
    webview.pluginId,
    "warn",
    `A link in the ${webview.viewType} webview asked to run ${command.command}, which its enableCommandUris does not allow`
  )
}

export interface WebviewFrameConnection {
  /** An envelope from the frame (already checked to come from it). */
  receive(data: unknown): void
  /** Push the app's current theme into the frame. */
  updateTheme(): void
  dispose(): void
}

/**
 * Speak the shell's envelopes for one frame. `post` puts an envelope into the
 * frame; `prepared` is the document it was loaded with.
 */
export function connectWebviewFrame(
  handle: string,
  prepared: PreparedWebviewFrame,
  post: (envelope: Record<string, unknown>) => void
): WebviewFrameConnection {
  const envelope = (kind: string, fields: Record<string, unknown> = {}) => ({
    [MARK]: kind,
    ...fields,
  })
  let ready = false
  let disposed = false
  const queued: unknown[] = []
  const deliver = (message: unknown) => post(envelope("message", { data: message }))
  const detach = attachWebviewFrame(handle, (message) => {
    if (disposed) return false
    if (ready) deliver(message)
    else queued.push(message)
    return true
  })

  const answerResource = (id: unknown, url: unknown) => {
    const webview = getWebview(handle)
    if (!webview || typeof url !== "string") return
    readResourceThroughHost(
      webview.pluginId,
      handle
    )(url).then(
      (resource) =>
        post(
          envelope("resource", {
            id,
            ok: true,
            data: bytesToBase64(resource.bytes),
            mime: resource.mime,
          })
        ),
      (error: unknown) => {
        log(webview.pluginId, "warn", error instanceof Error ? error.message : String(error))
        post(
          envelope("resource", {
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        )
      }
    )
  }

  return {
    receive(data) {
      if (disposed || !data || typeof data !== "object") return
      const message = data as Record<string, unknown>
      const webview = getWebview(handle)
      if (!webview) return
      switch (message[MARK]) {
        case "ready":
          post(
            envelope("load", {
              scripts: prepared.scripts,
              state: webview.state,
              ...(prepared.baseUrl ? { baseUrl: prepared.baseUrl } : {}),
            })
          )
          break
        case "loaded":
          ready = true
          for (const pending of queued.splice(0)) deliver(pending)
          break
        case "post":
          report(webview.pluginId, "webview:message", { handle, message: message.data })
          break
        case "set-state":
          setWebviewState(handle, message.state)
          break
        case "resource":
          answerResource(message.id, message.url)
          break
        case "link":
          if (typeof message.href === "string") {
            void openWebviewLink(handle, message.href).catch((error: unknown) => {
              log(webview.pluginId, "warn", error instanceof Error ? error.message : String(error))
            })
          }
          break
      }
    },
    updateTheme() {
      if (disposed) return
      const theme = requireDeps().theme()
      post(envelope("theme", { css: theme.css, kind: theme.kind }))
    },
    dispose() {
      disposed = true
      detach()
    },
  }
}

export function installVscodeWebviewHandlers(): Array<() => void> {
  return [
    registerMethod("window:createWebviewPanel", (payload, context) => {
      const value = owned(payload, context)
      const handle = requiredString(value, "handle")
      if (getWebview(handle)) throw new Error(`Webview ${handle} already exists`)
      addWebview(
        {
          handle,
          pluginId: context.pluginId,
          kind: "panel",
          viewType: requiredString(value, "viewType"),
          title: typeof value.title === "string" ? value.title : "",
          html: "",
          options: webviewOptionsOf(value.options),
        },
        { select: value.preserveFocus !== true }
      )
      return null
    }),
    registerMethod("window:registerWebviewViewProvider", (payload, context) => {
      const value = owned(payload, context)
      const viewId = requiredString(value, "viewId")
      const handle = `view:${context.pluginId}:${viewId}`
      // Re-registered after a restart of the host: the old view goes.
      removeWebview(handle)
      reportedVisible.delete(handle)
      addWebview(
        {
          handle,
          pluginId: context.pluginId,
          kind: "view",
          viewType: viewId,
          title: typeof value.title === "string" && value.title ? value.title : viewId,
          html: "",
          options: {
            ...DEFAULT_WEBVIEW_OPTIONS,
            retainContextWhenHidden: value.retainContextWhenHidden === true,
          },
          token: requiredString(value, "token"),
        },
        { select: false }
      )
      return null
    }),
    registerMethod("window:unregisterWebviewViewProvider", (payload, context) => {
      const value = owned(payload, context)
      const handle = `view:${context.pluginId}:${requiredString(value, "viewId")}`
      removeWebview(handle)
      reportedVisible.delete(handle)
      return null
    }),
    registerMethod("webview:update", (payload, context) => {
      const value = owned(payload, context)
      const webview = ownWebview(value, context)
      updateWebview(webview.handle, {
        ...(typeof value.html === "string" ? { html: value.html } : {}),
        ...(value.options !== undefined
          ? {
              options: {
                ...webviewOptionsOf(value.options),
                // A view's retention comes from its registration, not its webview options.
                retainContextWhenHidden: webview.options.retainContextWhenHidden,
              },
            }
          : {}),
        ...(typeof value.title === "string" ? { title: value.title } : {}),
        ...(value.description !== undefined
          ? { description: typeof value.description === "string" ? value.description : null }
          : {}),
        ...(value.badge !== undefined
          ? {
              badge:
                value.badge && typeof value.badge === "object"
                  ? {
                      value: Number((value.badge as { value?: unknown }).value) || 0,
                      tooltip: String((value.badge as { tooltip?: unknown }).tooltip ?? ""),
                    }
                  : null,
            }
          : {}),
      })
      return null
    }),
    registerMethod("webview:postMessage", (payload, context) => {
      const value = owned(payload, context)
      return postToWebview(ownWebview(value, context).handle, value.message)
    }),
    registerMethod("webview:reveal", (payload, context) => {
      const value = owned(payload, context)
      selectWebview(ownWebview(value, context).handle)
      return null
    }),
    registerMethod("webview:dispose", (payload, context) => {
      const value = owned(payload, context)
      const handle = requiredString(value, "handle")
      const webview = getWebview(handle)
      if (webview?.pluginId === context.pluginId) {
        removeWebview(handle)
        reportedVisible.delete(handle)
      }
      return null
    }),
  ]
}

/** The extension stopped: its webviews close with it. */
export function clearVscodeWebviewsForPlugin(pluginId: string): void {
  for (const webview of listWebviews()) {
    if (webview.pluginId !== pluginId) continue
    removeWebview(webview.handle)
    reportedVisible.delete(webview.handle)
  }
}

export function __resetVscodeWebviewsForTesting(): void {
  reportedVisible.clear()
  configureVscodeWebviews(null)
}
