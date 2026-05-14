/**
 * `vscode.window` — UI + active editor.
 *
 * Most methods proxy back to the renderer via the JSON-RPC connection.
 * Webview / Terminal / StatusBar return objects whose methods themselves
 * proxy back — the extension perceives a synchronous-looking API while
 * cognia's renderer handles the actual UI.
 *
 * `activeTextEditor` reads from a cached snapshot the renderer pushes via
 * the `window:activeEditorChanged` notification. Listeners receive a
 * faithful Disposable shape.
 */

import { Disposable, EventEmitter, type Uri } from "./types"
import type { ShimDependencies } from "./index"

interface RpcShowMessageButtons {
  title: string
  isCloseAffordance?: boolean
}

interface SidecarWindow {
  // Notifications
  showInformationMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>
  showWarningMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>
  showErrorMessage<T extends string>(message: string, ...items: T[]): Promise<T | undefined>
  showInputBox(options?: {
    prompt?: string
    placeHolder?: string
    value?: string
    password?: boolean
  }): Promise<string | undefined>
  showQuickPick<T extends string>(
    items: T[],
    options?: { placeHolder?: string }
  ): Promise<T | undefined>
  showOpenDialog(options?: {
    canSelectFiles?: boolean
    canSelectFolders?: boolean
    canSelectMany?: boolean
    title?: string
  }): Promise<Uri[] | undefined>
  showSaveDialog(options?: { title?: string; defaultUri?: Uri }): Promise<Uri | undefined>
  withProgress<T>(
    options: { location?: number; title?: string; cancellable?: boolean },
    task: (progress: {
      report: (msg: { increment?: number; message?: string }) => void
    }) => Promise<T>
  ): Promise<T>

  // Editors & decorations
  readonly activeTextEditor: { document: { uri: Uri; languageId: string } } | undefined
  readonly visibleTextEditors: ReadonlyArray<{ document: { uri: Uri; languageId: string } }>
  onDidChangeActiveTextEditor(listener: (e: unknown) => void): Disposable
  onDidChangeTextEditorSelection(listener: (e: unknown) => void): Disposable
  createTextEditorDecorationType(options: Record<string, unknown>): {
    key: string
    dispose(): void
  }

  // Webview
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: number | { viewColumn: number; preserveFocus?: boolean },
    options?: Record<string, unknown>
  ): WebviewPanel
  registerWebviewViewProvider(
    viewId: string,
    provider: { resolveWebviewView: (view: WebviewView) => unknown }
  ): Disposable
  registerUriHandler(handler: { handleUri: (uri: Uri) => unknown }): Disposable

  // Terminal
  createTerminal(options: {
    name: string
    shellPath?: string
    shellArgs?: string[]
    cwd?: string
    env?: Record<string, string>
  }): Terminal

  // Status bar
  createStatusBarItem(alignment?: number, priority?: number): StatusBarItem
  setStatusBarMessage(text: string, hideAfterTimeout?: number): Disposable

  // Output channel
  createOutputChannel(name: string): OutputChannel
}

export interface WebviewPanel {
  readonly viewType: string
  readonly webview: Webview
  title: string
  reveal(viewColumn?: number, preserveFocus?: boolean): void
  dispose(): void
  onDidChangeViewState(listener: (e: { webviewPanel: WebviewPanel }) => void): Disposable
  onDidDispose(listener: () => void): Disposable
}

export interface WebviewView {
  readonly webview: Webview
  readonly viewType: string
  show(preserveFocus?: boolean): void
  onDidChangeVisibility(listener: () => void): Disposable
  onDidDispose(listener: () => void): Disposable
  visible: boolean
}

export interface Webview {
  html: string
  cspSource: string
  postMessage(message: unknown): Promise<boolean>
  onDidReceiveMessage(listener: (e: unknown) => void): Disposable
  asWebviewUri(uri: Uri): Uri
}

export interface Terminal {
  readonly name: string
  readonly processId: Promise<number | undefined>
  sendText(text: string, addNewLine?: boolean): void
  show(preserveFocus?: boolean): void
  hide(): void
  dispose(): void
  readonly exitStatus: { code: number | null } | undefined
}

export interface StatusBarItem {
  text: string
  tooltip: string | undefined
  alignment: number
  priority: number | undefined
  show(): void
  hide(): void
  dispose(): void
}

export interface OutputChannel {
  readonly name: string
  append(value: string): void
  appendLine(value: string): void
  clear(): void
  show(preserveFocus?: boolean): void
  hide(): void
  dispose(): void
}

export function createWindowNamespace(deps: ShimDependencies): SidecarWindow {
  const { connection, extensionId } = deps
  let activeEditor: SidecarWindow["activeTextEditor"] = undefined
  let visibleEditors: SidecarWindow["visibleTextEditors"] = []
  const activeEditorEmitter = new EventEmitter<unknown>()
  const selectionEmitter = new EventEmitter<unknown>()

  connection.onNotification("window:activeEditorChanged", (params) => {
    activeEditor = params as SidecarWindow["activeTextEditor"]
    activeEditorEmitter.fire(activeEditor)
  })
  connection.onNotification("window:visibleEditorsChanged", (params) => {
    visibleEditors = (params as SidecarWindow["visibleTextEditors"]) ?? []
  })
  connection.onNotification("window:editorSelectionChanged", (params) => {
    selectionEmitter.fire(params)
  })

  const api: SidecarWindow = {
    async showInformationMessage<T extends string>(
      message: string,
      ...items: T[]
    ): Promise<T | undefined> {
      return connection.sendRequest("window:showMessage", {
        extensionId,
        severity: "info",
        message,
        items: items.map<RpcShowMessageButtons>((i) => ({ title: i })),
      })
    },
    async showWarningMessage<T extends string>(
      message: string,
      ...items: T[]
    ): Promise<T | undefined> {
      return connection.sendRequest("window:showMessage", {
        extensionId,
        severity: "warning",
        message,
        items: items.map((i) => ({ title: i })),
      })
    },
    async showErrorMessage<T extends string>(
      message: string,
      ...items: T[]
    ): Promise<T | undefined> {
      return connection.sendRequest("window:showMessage", {
        extensionId,
        severity: "error",
        message,
        items: items.map((i) => ({ title: i })),
      })
    },
    showInputBox(options) {
      return connection.sendRequest("window:showInputBox", { extensionId, options })
    },
    showQuickPick<T extends string>(
      items: T[],
      options?: { placeHolder?: string }
    ): Promise<T | undefined> {
      return connection.sendRequest<T | undefined>("window:showQuickPick", {
        extensionId,
        items,
        options,
      })
    },
    showOpenDialog(options) {
      return connection.sendRequest("window:showOpenDialog", { extensionId, options })
    },
    showSaveDialog(options) {
      return connection.sendRequest("window:showSaveDialog", { extensionId, options })
    },
    async withProgress(options, task) {
      const handle = await connection.sendRequest<string>("window:progressStart", {
        extensionId,
        options,
      })
      try {
        return await task({
          report: (msg) => {
            void connection.sendNotification("window:progressReport", { handle, msg })
          },
        })
      } finally {
        void connection.sendNotification("window:progressEnd", { handle })
      }
    },
    get activeTextEditor() {
      return activeEditor
    },
    get visibleTextEditors() {
      return visibleEditors
    },
    onDidChangeActiveTextEditor(listener) {
      return activeEditorEmitter.event(listener)
    },
    onDidChangeTextEditorSelection(listener) {
      return selectionEmitter.event(listener)
    },
    createTextEditorDecorationType(options) {
      const key = `deco:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
      void connection.sendRequest("window:registerDecorationType", {
        extensionId,
        key,
        options,
      })
      return {
        key,
        dispose: () => {
          void connection.sendNotification("window:disposeDecorationType", { key })
        },
      }
    },
    createWebviewPanel(viewType, title, showOptions, options) {
      return buildWebviewPanel(connection, extensionId, {
        viewType,
        title,
        showOptions,
        options,
      })
    },
    registerWebviewViewProvider(viewId, provider) {
      const token = `wvv:${extensionId}:${viewId}`
      deps.registerProviderCallback(token, async (payload) => {
        const view = buildWebviewView(connection, extensionId, viewId)
        try {
          await Promise.resolve(provider.resolveWebviewView(view))
        } catch (err) {
          process.stderr.write(
            `[vscode-shim] webview provider threw: ${err instanceof Error ? err.message : String(err)}\n`
          )
        }
        return { ok: true }
      })
      void connection.sendRequest("window:registerWebviewViewProvider", {
        extensionId,
        viewId,
        token,
      })
      return new Disposable(() => {
        void connection.sendNotification("window:unregisterWebviewViewProvider", {
          extensionId,
          viewId,
        })
      })
    },
    registerUriHandler(handler) {
      const token = `uri:${extensionId}`
      deps.registerProviderCallback(token, async (payload) => {
        const uri = payload as Uri
        try {
          await Promise.resolve(handler.handleUri(uri))
        } catch (err) {
          process.stderr.write(
            `[vscode-shim] URI handler threw: ${err instanceof Error ? err.message : String(err)}\n`
          )
        }
        return { ok: true }
      })
      void connection.sendRequest("window:registerUriHandler", { extensionId, token })
      return new Disposable(() => {
        void connection.sendNotification("window:unregisterUriHandler", { extensionId })
      })
    },
    createTerminal(options) {
      return buildTerminal(connection, extensionId, options)
    },
    createStatusBarItem(alignment = 1, priority) {
      return buildStatusBarItem(connection, extensionId, alignment, priority)
    },
    setStatusBarMessage(text, hideAfterTimeout) {
      const handle = `sbm:${Math.random().toString(36).slice(2, 10)}`
      void connection.sendRequest("window:setStatusBarMessage", {
        extensionId,
        handle,
        text,
        hideAfterTimeout,
      })
      return new Disposable(() => {
        void connection.sendNotification("window:clearStatusBarMessage", { handle })
      })
    },
    createOutputChannel(name) {
      return buildOutputChannel(connection, extensionId, name)
    },
  }
  return api
}

// ────────────────────────────────────────────────────────────────────────
// Object builders
// ────────────────────────────────────────────────────────────────────────

function buildWebviewPanel(
  connection: ShimDependencies["connection"],
  extensionId: string,
  init: { viewType: string; title: string; showOptions: unknown; options: unknown }
): WebviewPanel {
  const panelId = `panel:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
  const messageEmitter = new EventEmitter<unknown>()
  const stateEmitter = new EventEmitter<{ webviewPanel: WebviewPanel }>()
  const disposeEmitter = new EventEmitter<void>()
  let title = init.title
  let html = ""

  void connection.sendRequest("window:createWebviewPanel", {
    extensionId,
    panelId,
    viewType: init.viewType,
    title,
    showOptions: init.showOptions,
    options: init.options,
  })

  connection.onNotification(`webview:${panelId}:message`, (data) => {
    messageEmitter.fire(data)
  })
  connection.onNotification(`webview:${panelId}:viewState`, () => {
    stateEmitter.fire({ webviewPanel: panel })
  })
  connection.onNotification(`webview:${panelId}:dispose`, () => {
    disposeEmitter.fire(undefined)
  })

  const webview: Webview = {
    get html() {
      return html
    },
    set html(value: string) {
      html = value
      void connection.sendNotification("webview:setHtml", { panelId, html: value })
    },
    get cspSource() {
      return "cognia-webview://"
    },
    postMessage(message): Promise<boolean> {
      return connection.sendRequest("webview:postMessage", { panelId, message })
    },
    onDidReceiveMessage(listener): Disposable {
      return messageEmitter.event(listener)
    },
    asWebviewUri(uri): Uri {
      return uri // The renderer-side bridge prefixes the resource scheme.
    },
  }

  const panel: WebviewPanel = {
    viewType: init.viewType,
    webview,
    get title() {
      return title
    },
    set title(value: string) {
      title = value
      void connection.sendNotification("webview:setTitle", { panelId, title: value })
    },
    reveal(viewColumn, preserveFocus) {
      void connection.sendNotification("webview:reveal", { panelId, viewColumn, preserveFocus })
    },
    dispose() {
      void connection.sendNotification("webview:dispose", { panelId })
    },
    onDidChangeViewState(listener) {
      return stateEmitter.event(listener)
    },
    onDidDispose(listener) {
      return disposeEmitter.event(listener)
    },
  }
  return panel
}

function buildWebviewView(
  connection: ShimDependencies["connection"],
  extensionId: string,
  viewId: string
): WebviewView {
  const panelId = `view:${extensionId}:${viewId}`
  const messageEmitter = new EventEmitter<unknown>()
  const visibilityEmitter = new EventEmitter<void>()
  const disposeEmitter = new EventEmitter<void>()
  let visible = true
  let html = ""

  connection.onNotification(`webview:${panelId}:message`, (data) => {
    messageEmitter.fire(data)
  })
  connection.onNotification(`webview:${panelId}:visibility`, (params) => {
    visible = (params as { visible: boolean }).visible
    visibilityEmitter.fire(undefined)
  })

  const webview: Webview = {
    get html() {
      return html
    },
    set html(value: string) {
      html = value
      void connection.sendNotification("webview:setHtml", { panelId, html: value })
    },
    get cspSource() {
      return "cognia-webview://"
    },
    postMessage(message): Promise<boolean> {
      return connection.sendRequest("webview:postMessage", { panelId, message })
    },
    onDidReceiveMessage(listener): Disposable {
      return messageEmitter.event(listener)
    },
    asWebviewUri(uri): Uri {
      return uri
    },
  }

  return {
    webview,
    viewType: viewId,
    show(preserveFocus) {
      void connection.sendNotification("webview:show", { panelId, preserveFocus })
    },
    onDidChangeVisibility(listener) {
      return visibilityEmitter.event(listener)
    },
    onDidDispose(listener) {
      return disposeEmitter.event(listener)
    },
    get visible() {
      return visible
    },
    set visible(_value: boolean) {
      // VS Code spec: this is read-only at runtime, but extensions can show()/hide().
    },
  }
}

function buildTerminal(
  connection: ShimDependencies["connection"],
  extensionId: string,
  options: {
    name: string
    shellPath?: string
    shellArgs?: string[]
    cwd?: string
    env?: Record<string, string>
  }
): Terminal {
  const terminalId = `term:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
  const pidPromise = connection.sendRequest<number | undefined>("terminal:create", {
    extensionId,
    terminalId,
    options,
  })
  let exitStatus: Terminal["exitStatus"] = undefined
  connection.onNotification(`terminal:${terminalId}:close`, (params) => {
    exitStatus = { code: (params as { code: number | null }).code }
  })
  return {
    name: options.name,
    processId: pidPromise,
    sendText(text, addNewLine = true) {
      void connection.sendNotification("terminal:sendText", {
        terminalId,
        text,
        addNewLine,
      })
    },
    show(preserveFocus) {
      void connection.sendNotification("terminal:show", { terminalId, preserveFocus })
    },
    hide() {
      void connection.sendNotification("terminal:hide", { terminalId })
    },
    dispose() {
      void connection.sendNotification("terminal:dispose", { terminalId })
    },
    get exitStatus() {
      return exitStatus
    },
  }
}

function buildStatusBarItem(
  connection: ShimDependencies["connection"],
  extensionId: string,
  alignment: number,
  priority: number | undefined
): StatusBarItem {
  const itemId = `sb:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
  let text = ""
  let tooltip: string | undefined
  void connection.sendRequest("window:createStatusBarItem", {
    extensionId,
    itemId,
    alignment,
    priority,
  })
  return {
    get text() {
      return text
    },
    set text(v: string) {
      text = v
      void connection.sendNotification("window:setStatusBarText", { itemId, text: v })
    },
    get tooltip() {
      return tooltip
    },
    set tooltip(v: string | undefined) {
      tooltip = v
      void connection.sendNotification("window:setStatusBarTooltip", { itemId, tooltip: v })
    },
    alignment,
    priority,
    show() {
      void connection.sendNotification("window:showStatusBarItem", { itemId })
    },
    hide() {
      void connection.sendNotification("window:hideStatusBarItem", { itemId })
    },
    dispose() {
      void connection.sendNotification("window:disposeStatusBarItem", { itemId })
    },
  }
}

function buildOutputChannel(
  connection: ShimDependencies["connection"],
  extensionId: string,
  name: string
): OutputChannel {
  const channelId = `ch:${extensionId}:${name}`
  void connection.sendRequest("window:createOutputChannel", {
    extensionId,
    channelId,
    name,
  })
  return {
    name,
    append(value) {
      void connection.sendNotification("window:outputChannelAppend", { channelId, value })
    },
    appendLine(value) {
      void connection.sendNotification("window:outputChannelAppend", {
        channelId,
        value: `${value}\n`,
      })
    },
    clear() {
      void connection.sendNotification("window:outputChannelClear", { channelId })
    },
    show(preserveFocus) {
      void connection.sendNotification("window:outputChannelShow", { channelId, preserveFocus })
    },
    hide() {
      void connection.sendNotification("window:outputChannelHide", { channelId })
    },
    dispose() {
      void connection.sendNotification("window:outputChannelDispose", { channelId })
    },
  }
}
