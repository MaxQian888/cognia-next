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
import { createTerminalWindowMembers } from "./terminal"
import { createWebviewWindowMembers } from "./webviews"
import { createUnsupportedApiReporter, createUnsupportedWindowMembers } from "./unsupported-members"
import type { ColorTheme, WindowState } from "./window-state"

type MessageItem = string | { title: string; isCloseAffordance?: boolean }

type TerminalWindowMembers = ReturnType<typeof createTerminalWindowMembers>
type WebviewWindowMembers = ReturnType<typeof createWebviewWindowMembers>
type UnsupportedWindowMembers = ReturnType<typeof createUnsupportedWindowMembers>

interface SidecarWindow
  extends TerminalWindowMembers, WebviewWindowMembers, UnsupportedWindowMembers {
  // The app window's focus and theme (`window-state.ts`).
  readonly state: WindowState
  onDidChangeWindowState(listener: (e: WindowState) => void): Disposable
  readonly activeColorTheme: ColorTheme
  onDidChangeActiveColorTheme(listener: (e: ColorTheme) => void): Disposable

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
  onDidChangeTextEditorViewColumn(listener: (e: unknown) => void): Disposable
  createTextEditorDecorationType(options: Record<string, unknown>): {
    key: string
    dispose(): void
  }

  registerUriHandler(handler: { handleUri: (uri: Uri) => unknown }): Disposable

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

export type OutputChannel = ReturnType<typeof createOutputChannel>

export function createWindowNamespace(deps: ShimDependencies): SidecarWindow {
  const { connection, extensionId } = deps
  const documents = deps.documents
  let uriHandlerRegistered = false
  const webviews = createWebviewWindowMembers({
    registry: deps.webviews,
    connection,
    extensionId,
    extensionPath: () => deps.ownedPaths().readOnly[0],
    defaultRoots: () => [
      ...deps.ownedPaths().readOnly.slice(0, 1),
      ...(deps.folders.folders ?? []).map((folder) => folder.uri.fsPath),
    ],
    registerProviderCallback: deps.registerProviderCallback,
  })
  const terminals = createTerminalWindowMembers({
    registry: deps.terminals,
    connection,
    extensionId,
  })

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
    // Every editor is in the one editor area (`viewColumn` is always 1), so
    // its column never changes.
    onDidChangeTextEditorViewColumn: new EventEmitter<unknown>().event,
    get state() {
      return deps.windowEnvironment.state
    },
    onDidChangeWindowState(listener) {
      return deps.windowEnvironment.onDidChangeState.event(listener)
    },
    get activeColorTheme() {
      return deps.windowEnvironment.colorTheme
    },
    onDidChangeActiveColorTheme(listener) {
      return deps.windowEnvironment.onDidChangeColorTheme.event(listener)
    },
    createWebviewPanel: webviews.createWebviewPanel,
    registerWebviewViewProvider: webviews.registerWebviewViewProvider,
    registerWebviewPanelSerializer: webviews.registerWebviewPanelSerializer,
    registerUriHandler(handler) {
      // As in VS Code, one handler at a time; the app routes
      // `cognia://<extension id>/...` links to it.
      if (uriHandlerRegistered) {
        throw new Error(`A URI handler is already registered for ${extensionId}`)
      }
      uriHandlerRegistered = true
      const token = `uri:${extensionId}`
      const unregisterCallback = deps.registerProviderCallback(token, async (payload) => {
        const uri = Uri.revive(payload)
        if (!uri) return { ok: false }
        try {
          await Promise.resolve(handler.handleUri(uri))
        } catch (err) {
          process.stderr.write(
            `[vscode-shim] ${extensionId}: URI handler threw: ${err instanceof Error ? err.message : String(err)}\n`
          )
        }
        return { ok: true }
      })
      connection
        .sendRequest("window:registerUriHandler", { extensionId, token })
        .catch((error: unknown) => {
          process.stderr.write(
            `[vscode-shim] ${extensionId}: URI handler not registered: ${error instanceof Error ? error.message : String(error)}\n`
          )
        })
      let disposed = false
      return new Disposable(() => {
        if (disposed) return
        disposed = true
        uriHandlerRegistered = false
        unregisterCallback()
        void connection.sendNotification("window:unregisterUriHandler", { extensionId })
      })
    },
    createTerminal: terminals.createTerminal,
    get terminals() {
      return terminals.terminals
    },
    get activeTerminal() {
      return terminals.activeTerminal
    },
    onDidOpenTerminal: terminals.onDidOpenTerminal,
    onDidCloseTerminal: terminals.onDidCloseTerminal,
    onDidChangeActiveTerminal: terminals.onDidChangeActiveTerminal,
    onDidChangeTerminalState: terminals.onDidChangeTerminalState,
    onDidChangeTerminalShellIntegration: terminals.onDidChangeTerminalShellIntegration,
    onDidStartTerminalShellExecution: terminals.onDidStartTerminalShellExecution,
    onDidEndTerminalShellExecution: terminals.onDidEndTerminalShellExecution,
    createStatusBarItem: (...args) => createStatusBarItem(connection, extensionId, args),
    setStatusBarMessage: (text, hideAfter) =>
      setStatusBarMessage(connection, extensionId, text, hideAfter),
    createOutputChannel: (name, options) =>
      createOutputChannel(connection, extensionId, name, options),
    ...createUnsupportedWindowMembers(createUnsupportedApiReporter(connection, extensionId)),
  }
  return api
}
