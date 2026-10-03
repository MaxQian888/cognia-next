/**
 * Renderer side of `vscode.window`'s messages, quick input, progress, status
 * bar, output channels and file dialogs.
 *
 * Each handler checks the request is the calling extension's own, records
 * state in `window-ui-store.ts`, and asks the presenter to show it. The
 * presenter is the React side (`components/plugins/vscode/vscode-window-presenter.tsx`,
 * installed by the loader); keeping it behind an interface leaves these
 * handlers testable without a DOM.
 */

import { loggers } from "@cognia/logging"

import type { PluginLogLevel } from "@/lib/plugin/devtools/runtime-log-stream"

import { appendVscodeLog } from "./vscode-log-buffer"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import {
  clearStatusBarMessage,
  clearVscodeWindowForPlugin,
  closeQuickInputSession,
  endProgress,
  getQuickInputSession,
  openQuickInputSession,
  pluginsWithStatusBarEntries,
  removeStatusBarItem,
  reportProgress,
  setStatusBarItem,
  setStatusBarMessage,
  startProgress,
  updateQuickInputSession,
  type QuickInputState,
  type StatusBarItemState,
} from "./window-ui-store"

const log = loggers.plugin.child("vscode-window")

export interface VscodeMessageRequest {
  pluginId: string
  severity: "info" | "warning" | "error"
  message: string
  detail?: string
  modal: boolean
  items: Array<{ title: string; isCloseAffordance?: boolean }>
}

export interface VscodeOpenDialogOptions {
  defaultUri?: string
  openLabel?: string
  canSelectFiles?: boolean
  canSelectFolders?: boolean
  canSelectMany?: boolean
  filters?: Record<string, string[]>
  title?: string
}

export interface VscodeSaveDialogOptions {
  defaultUri?: string
  saveLabel?: string
  filters?: Record<string, string[]>
  title?: string
}

/** The UI side; see the module comment. */
export interface VscodeWindowPresenter {
  /** Resolve with the chosen item's index, or `null` when dismissed. */
  showMessage(request: VscodeMessageRequest): Promise<number | null>
  /** Show the quick input; `close()` removes it without reporting a dismissal. */
  openQuickInput(pluginId: string, sessionId: string): { close(): void }
  /** A notification-located progress began. */
  showProgress(pluginId: string, handle: string): void
  /** It ended (or its plugin stopped). */
  hideProgress(handle: string): void
  /** The plugin has (or no longer has) status bar entries. */
  syncStatusBar(pluginIds: string[]): void
  /** `OutputChannel.show()`: offer to open the plugin's logs. */
  outputShown(pluginId: string, channel: string): void
  /** Native file dialogs; file URIs, or `null` when cancelled. */
  pickOpen(options: VscodeOpenDialogOptions): Promise<string[] | null>
  pickSave(options: VscodeSaveDialogOptions): Promise<string | null>
}

/** Tell the extension host what the user did. */
export type SendToHost = (pluginId: string, method: string, payload: unknown) => Promise<unknown>

let presenter: VscodeWindowPresenter | null = null
let sendToHost: SendToHost = async () => {
  throw new Error("VS Code window handlers have no extension host connection")
}
const quickInputHandles = new Map<string, { close(): void }>()
/** `plugin\u0000channel` → the line written so far without its newline. */
const partialLines = new Map<string, string>()

export function configureVscodeWindow(input: {
  presenter: VscodeWindowPresenter
  sendToHost: SendToHost
}): void {
  presenter = input.presenter
  sendToHost = input.sendToHost
}

function requirePresenter(): VscodeWindowPresenter {
  if (!presenter) throw new Error("The VS Code window UI is not available in this window")
  return presenter
}

function owned<T extends Record<string, unknown>>(payload: unknown, context: RpcContext): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  const value = payload as T
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

/** Report a user action on a quick input; a host that has gone away has nothing to hear. */
export function sendQuickInputEvent(pluginId: string, sessionId: string, event: unknown): void {
  sendToHost(pluginId, "window:quickInputEvent", { sessionId, event }).catch((error: unknown) =>
    log.debug("quick input event not delivered", {
      pluginId,
      error: error instanceof Error ? error.message : String(error),
    })
  )
}

/** The user dismissed a quick input (escape, click outside). */
export function dismissQuickInput(sessionId: string): void {
  const session = closeQuickInputSession(sessionId)
  quickInputHandles.delete(sessionId)
  if (session) sendQuickInputEvent(session.pluginId, sessionId, { type: "hide" })
}

/** The user cancelled a cancellable notification progress. */
export function cancelProgress(pluginId: string, handle: string): void {
  sendToHost(pluginId, "window:progressCancel", { handle }).catch(() => {
    // The task already ended; nothing to cancel.
  })
}

function writeOutput(
  pluginId: string,
  channel: string,
  value: string,
  level: PluginLogLevel = "info"
) {
  const key = `${pluginId}\u0000${channel}`
  const text = (partialLines.get(key) ?? "") + value
  const lines = text.split(/\r?\n/)
  partialLines.set(key, lines.pop() ?? "")
  for (const line of lines) {
    appendVscodeLog(pluginId, { level, message: line, kind: `output:${channel}` })
  }
}

function flushOutput(pluginId: string, channel: string): void {
  const key = `${pluginId}\u0000${channel}`
  const rest = partialLines.get(key)
  partialLines.delete(key)
  if (rest) appendVscodeLog(pluginId, { level: "info", message: rest, kind: `output:${channel}` })
}

/** Remove everything a plugin showed; called when its host stops. */
export function clearVscodeWindowUi(pluginId: string): void {
  const { quickInputs, progress } = clearVscodeWindowForPlugin(pluginId)
  for (const session of quickInputs) {
    quickInputHandles.get(session.sessionId)?.close()
    quickInputHandles.delete(session.sessionId)
  }
  for (const state of progress) presenter?.hideProgress(state.handle)
  for (const key of [...partialLines.keys()]) {
    if (key.startsWith(`${pluginId}\u0000`)) flushOutput(pluginId, key.slice(pluginId.length + 1))
  }
  presenter?.syncStatusBar(pluginsWithStatusBarEntries())
}

export function installVscodeWindowHandlers(): Array<() => void> {
  const disposers: Array<() => void> = []
  const on = (method: string, handler: Parameters<typeof registerMethod>[1]) =>
    disposers.push(registerMethod(method, handler))

  on("window:showMessage", (payload, context) => {
    const value = owned<{
      severity?: string
      message?: unknown
      detail?: unknown
      modal?: unknown
      items?: unknown
    }>(payload, context)
    const severity =
      value.severity === "warning" || value.severity === "error" ? value.severity : "info"
    const items = Array.isArray(value.items)
      ? value.items
          .filter(
            (item): item is { title: string; isCloseAffordance?: boolean } =>
              Boolean(item) && typeof (item as { title?: unknown }).title === "string"
          )
          .map((item) => ({
            title: item.title,
            ...(item.isCloseAffordance ? { isCloseAffordance: true } : {}),
          }))
      : []
    return requirePresenter().showMessage({
      pluginId: context.pluginId,
      severity,
      message: String(value.message ?? ""),
      ...(typeof value.detail === "string" && value.detail ? { detail: value.detail } : {}),
      modal: value.modal === true,
      items,
    })
  })

  on("window:quickInputOpen", (payload, context) => {
    const value = owned<{ sessionId?: unknown; kind?: unknown; state?: unknown }>(payload, context)
    if (typeof value.sessionId !== "string") throw new Error("quickInputOpen requires a sessionId")
    const ui = requirePresenter()
    openQuickInputSession({
      sessionId: value.sessionId,
      pluginId: context.pluginId,
      kind: value.kind === "input" ? "input" : "pick",
      state: (value.state ?? {}) as QuickInputState,
    })
    quickInputHandles.set(value.sessionId, ui.openQuickInput(context.pluginId, value.sessionId))
    return null
  })
  on("window:quickInputUpdate", (payload, context) => {
    const { sessionId, state } = payload as { sessionId: string; state: QuickInputState }
    if (getQuickInputSession(sessionId)?.pluginId !== context.pluginId) return null
    updateQuickInputSession(sessionId, state ?? {})
    return null
  })
  on("window:quickInputClose", (payload, context) => {
    const { sessionId } = payload as { sessionId: string }
    if (getQuickInputSession(sessionId)?.pluginId !== context.pluginId) return null
    closeQuickInputSession(sessionId)
    quickInputHandles.get(sessionId)?.close()
    quickInputHandles.delete(sessionId)
    return null
  })

  on("window:progressStart", (payload, context) => {
    const value = owned<{
      handle?: unknown
      location?: unknown
      title?: unknown
      cancellable?: unknown
    }>(payload, context)
    if (typeof value.handle !== "string") throw new Error("progressStart requires a handle")
    const location = value.location === "notification" ? "notification" : "statusBar"
    startProgress({
      handle: value.handle,
      pluginId: context.pluginId,
      location,
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      cancellable: location === "notification" && value.cancellable === true,
    })
    if (location === "notification") requirePresenter().showProgress(context.pluginId, value.handle)
    else presenter?.syncStatusBar(pluginsWithStatusBarEntries())
    return null
  })
  on("window:progressReport", (payload) => {
    const { handle, message, increment } = payload as {
      handle: string
      message?: string
      increment?: number
    }
    reportProgress(handle, { message, increment })
    return null
  })
  on("window:progressEnd", (payload) => {
    const ended = endProgress((payload as { handle: string }).handle)
    if (ended?.location === "notification") presenter?.hideProgress(ended.handle)
    else if (ended) presenter?.syncStatusBar(pluginsWithStatusBarEntries())
    return null
  })

  on("window:statusBarItem", (payload, context) => {
    const value = owned<{ itemId?: unknown; state?: unknown }>(payload, context)
    if (typeof value.itemId !== "string") return null
    setStatusBarItem(context.pluginId, value.itemId, value.state as StatusBarItemState)
    presenter?.syncStatusBar(pluginsWithStatusBarEntries())
    return null
  })
  on("window:statusBarItemDispose", (payload, context) => {
    const value = owned<{ itemId?: unknown }>(payload, context)
    if (typeof value.itemId === "string") removeStatusBarItem(context.pluginId, value.itemId)
    presenter?.syncStatusBar(pluginsWithStatusBarEntries())
    return null
  })
  on("window:setStatusBarMessage", (payload, context) => {
    const value = owned<{ handle?: unknown; text?: unknown }>(payload, context)
    if (typeof value.handle === "string") {
      setStatusBarMessage(context.pluginId, value.handle, String(value.text ?? ""))
    }
    presenter?.syncStatusBar(pluginsWithStatusBarEntries())
    return null
  })
  on("window:clearStatusBarMessage", (payload, context) => {
    const value = owned<{ handle?: unknown }>(payload, context)
    if (typeof value.handle === "string") clearStatusBarMessage(context.pluginId, value.handle)
    presenter?.syncStatusBar(pluginsWithStatusBarEntries())
    return null
  })

  on("window:outputChannel", (payload, context) => {
    const value = owned<{ channel?: unknown; op?: unknown; value?: unknown; level?: unknown }>(
      payload,
      context
    )
    const channel = String(value.channel ?? "")
    const text = typeof value.value === "string" ? value.value : ""
    switch (value.op) {
      case "append":
        writeOutput(context.pluginId, channel, text)
        break
      case "log": {
        // The log stream has no trace level; trace lines are debug lines.
        const level: PluginLogLevel =
          value.level === "trace" || value.level === "debug"
            ? "debug"
            : value.level === "warn" || value.level === "error"
              ? value.level
              : "info"
        flushOutput(context.pluginId, channel)
        writeOutput(context.pluginId, channel, `${text}\n`, level)
        break
      }
      case "replace":
        // The log stream is append-only: say the channel was replaced, then write it.
        flushOutput(context.pluginId, channel)
        appendVscodeLog(context.pluginId, {
          level: "info",
          message: `[${channel} replaced]`,
          kind: `output:${channel}`,
        })
        writeOutput(context.pluginId, channel, text.endsWith("\n") ? text : `${text}\n`)
        break
      case "clear":
        flushOutput(context.pluginId, channel)
        appendVscodeLog(context.pluginId, {
          level: "info",
          message: `[${channel} cleared]`,
          kind: `output:${channel}`,
        })
        break
      case "show":
        flushOutput(context.pluginId, channel)
        presenter?.outputShown(context.pluginId, channel)
        break
      case "dispose":
        flushOutput(context.pluginId, channel)
        break
    }
    return null
  })

  on("window:showOpenDialog", (payload, context) => {
    const value = owned<{ options?: unknown }>(payload, context)
    return requirePresenter().pickOpen((value.options ?? {}) as VscodeOpenDialogOptions)
  })
  on("window:showSaveDialog", (payload, context) => {
    const value = owned<{ options?: unknown }>(payload, context)
    return requirePresenter().pickSave((value.options ?? {}) as VscodeSaveDialogOptions)
  })

  return disposers
}

export function __resetVscodeWindowHandlersForTesting(): void {
  presenter = null
  quickInputHandles.clear()
  partialLines.clear()
}
