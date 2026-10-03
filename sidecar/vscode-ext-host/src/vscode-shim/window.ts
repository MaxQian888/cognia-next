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

import {
  InputBox,
  QuickPick,
  showInputBox,
  showQuickPick,
  type InputBoxOptions,
  type QuickPickItem,
  type QuickPickOptions,
} from "./quick-input"
import {
  Disposable,
  EventEmitter,
  Selection,
  Uri,
  type CancellationToken,
  type Range,
} from "./types"
import {
  createOutputChannel,
  createStatusBarItem,
  setStatusBarMessage,
  withProgress,
  type StatusBarItem,
} from "./window-surfaces"
import type { TextDocument, TextEditor } from "./documents"
import type { WorkspaceFolder } from "./workspace-folders"
import type { ShimDependencies } from "./index"

type MessageItem = string | { title: string; isCloseAffordance?: boolean }

interface SidecarWindow {
  // Messages: `(message, ...items)` or `(message, options, ...items)`.
  showInformationMessage(message: string, ...rest: unknown[]): Promise<MessageItem | undefined>
  showWarningMessage(message: string, ...rest: unknown[]): Promise<MessageItem | undefined>
  showErrorMessage(message: string, ...rest: unknown[]): Promise<MessageItem | undefined>
  showInputBox(options?: InputBoxOptions, token?: CancellationToken): Promise<string | undefined>
  showQuickPick(
    items: readonly (string | QuickPickItem)[] | Thenable<readonly (string | QuickPickItem)[]>,
    options?: QuickPickOptions,
    token?: CancellationToken
  ): Promise<unknown>
  createQuickPick<T extends QuickPickItem>(): QuickPick<T>
  createInputBox(): InputBox
  showWorkspaceFolderPick(options?: {
    placeHolder?: string
    ignoreFocusOut?: boolean
  }): Promise<WorkspaceFolder | undefined>
  showOpenDialog(options?: OpenDialogOptions): Promise<Uri[] | undefined>
  showSaveDialog(options?: SaveDialogOptions): Promise<Uri | undefined>
  withProgress<R>(
    options: { location: number | { viewId: string }; title?: string; cancellable?: boolean },
    task: (
      progress: { report(value: { message?: string; increment?: number }): void },
      token: CancellationToken
    ) => Thenable<R>
  ): Promise<R>

  // Editors & decorations
  /**
   * Open the document in the project editor and answer its editor. Only
   * files from the open project can be shown; column and preview are not
   * meaningful with a single editor area.
   */
  showTextDocument(
    document: TextDocument | Uri,
    columnOrOptions?:
      | number
      | { viewColumn?: number; preserveFocus?: boolean; preview?: boolean; selection?: Range },
    preserveFocus?: boolean
  ): Promise<TextEditor>
  readonly activeTextEditor: TextEditor | undefined
  readonly visibleTextEditors: readonly TextEditor[]
  onDidChangeActiveTextEditor(listener: (e: TextEditor | undefined) => void): Disposable
  onDidChangeVisibleTextEditors(listener: (e: readonly TextEditor[]) => void): Disposable
  onDidChangeTextEditorSelection(listener: (e: unknown) => void): Disposable
  onDidChangeTextEditorVisibleRanges(listener: (e: unknown) => void): Disposable
  onDidChangeTextEditorOptions(listener: (e: unknown) => void): Disposable
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
  createStatusBarItem(...args: unknown[]): StatusBarItem
  setStatusBarMessage(text: string, hideAfter?: number | Thenable<unknown>): Disposable

  // Output channel: `(name, languageId?)`, or `(name, { log: true })` for a LogOutputChannel.
  createOutputChannel(name: string, options?: string | { log: true }): OutputChannel
}

interface OpenDialogOptions {
  defaultUri?: Uri
  openLabel?: string
  canSelectFiles?: boolean
  canSelectFolders?: boolean
  canSelectMany?: boolean
  filters?: Record<string, string[]>
  title?: string
}

interface SaveDialogOptions {
  defaultUri?: Uri
  saveLabel?: string
  filters?: Record<string, string[]>
  title?: string
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

export type OutputChannel = ReturnType<typeof createOutputChannel>

export function createWindowNamespace(deps: ShimDependencies): SidecarWindow {
  const { connection, extensionId } = deps
  const documents = deps.documents

  /**
   * `show*Message(message, ...items)` or `(message, options, ...items)`.
   * Items are strings or `MessageItem`s; the chosen one comes back as given.
   */
  async function showMessage(
    severity: "info" | "warning" | "error",
    message: string,
    rest: unknown[]
  ): Promise<MessageItem | undefined> {
    const first = rest[0]
    const hasOptions =
      typeof first === "object" && first !== null && !("title" in (first as object))
    const options = (hasOptions ? first : {}) as { modal?: boolean; detail?: string }
    const items = (hasOptions ? rest.slice(1) : rest).filter(
      (item): item is MessageItem =>
        typeof item === "string" || (typeof item === "object" && item !== null)
    )
    const chosen = await connection.sendRequest<number | null>("window:showMessage", {
      extensionId,
      severity,
      message,
      ...(options.detail ? { detail: options.detail } : {}),
      modal: Boolean(options.modal),
      items: items.map((item) =>
        typeof item === "string"
          ? { title: item }
          : { title: item.title, ...(item.isCloseAffordance ? { isCloseAffordance: true } : {}) }
      ),
    })
    return typeof chosen === "number" ? items[chosen] : undefined
  }

  const api: SidecarWindow = {
    showInformationMessage: (message, ...rest) => showMessage("info", message, rest),
    showWarningMessage: (message, ...rest) => showMessage("warning", message, rest),
    showErrorMessage: (message, ...rest) => showMessage("error", message, rest),
    showInputBox: (options, token) => showInputBox(connection, extensionId, options, token),
    showQuickPick: (items, options, token) =>
      showQuickPick(connection, extensionId, items, options, token),
    createQuickPick: <T extends QuickPickItem>() => new QuickPick<T>(connection, extensionId),
    createInputBox: () => new InputBox(connection, extensionId),
    async showWorkspaceFolderPick(options) {
      const folders = deps.folders.folders ?? []
      if (folders.length === 0) return undefined
      const items = folders.map((folder, index) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        index,
      }))
      const picked = (await showQuickPick(connection, extensionId, items, {
        placeHolder: options?.placeHolder,
        ignoreFocusOut: options?.ignoreFocusOut,
      })) as (typeof items)[number] | undefined
      return picked ? folders[picked.index] : undefined
    },
    async showOpenDialog(options) {
      const picked = await connection.sendRequest<string[] | null>("window:showOpenDialog", {
        extensionId,
        options: {
          ...options,
          ...(options?.defaultUri ? { defaultUri: options.defaultUri.toString() } : {}),
        },
      })
      return picked && picked.length > 0 ? picked.map((uri) => Uri.parse(uri)) : undefined
    },
    async showSaveDialog(options) {
      const picked = await connection.sendRequest<string | null>("window:showSaveDialog", {
        extensionId,
        options: {
          ...options,
          ...(options?.defaultUri ? { defaultUri: options.defaultUri.toString() } : {}),
        },
      })
      return picked ? Uri.parse(picked) : undefined
    },
    withProgress: (options, task) => withProgress(connection, extensionId, options, task),
    async showTextDocument(document, columnOrOptions) {
      const uri = document instanceof Uri ? document.toString() : document.uri.toString()
      const selection =
        typeof columnOrOptions === "object" && columnOrOptions?.selection
          ? columnOrOptions.selection
          : undefined
      const shown = await connection.sendRequest<{ uri: string }>("window:showTextDocument", {
        extensionId,
        uri,
        ...(selection
          ? {
              selection: {
                start: { line: selection.start.line, character: selection.start.character },
                end: { line: selection.end.line, character: selection.end.character },
              },
            }
          : {}),
      })
      const editor = await documents.waitForEditor(shown.uri)
      if (!editor) throw new Error(`The editor for ${shown.uri} did not open`)
      // The editor opened at the selection's start; select all of it.
      if (selection) editor.selection = new Selection(selection.start, selection.end)
      return editor
    },
    get activeTextEditor() {
      return documents.activeEditor
    },
    get visibleTextEditors() {
      return documents.visibleEditors
    },
    onDidChangeActiveTextEditor(listener) {
      return documents.onDidChangeActiveEditor.event(listener)
    },
    onDidChangeVisibleTextEditors(listener) {
      return documents.onDidChangeVisibleEditors.event(listener)
    },
    onDidChangeTextEditorSelection(listener) {
      return documents.onDidChangeSelection.event(listener)
    },
    createTextEditorDecorationType(options) {
      const key = `deco:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
      connection
        .sendRequest("window:registerDecorationType", { extensionId, key, options })
        .catch((error: unknown) => {
          process.stderr.write(
            `[vscode-shim] ${extensionId}: decoration type not registered: ${error instanceof Error ? error.message : String(error)}\n`
          )
        })
      return {
        key,
        dispose: () => {
          void connection.sendNotification("window:disposeDecorationType", { extensionId, key })
        },
      }
    },
    onDidChangeTextEditorVisibleRanges(listener) {
      return documents.onDidChangeVisibleRanges.event(listener)
    },
    onDidChangeTextEditorOptions(listener) {
      return documents.onDidChangeOptions.event(listener)
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
      deps.registerProviderCallback(token, async (_payload) => {
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
    createStatusBarItem: (...args) => createStatusBarItem(connection, extensionId, args),
    setStatusBarMessage: (text, hideAfter) =>
      setStatusBarMessage(connection, extensionId, text, hideAfter),
    createOutputChannel: (name, options) =>
      createOutputChannel(connection, extensionId, name, options),
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
