/**
 * `vscode.workspace` — files, configuration, document lifecycle.
 *
 * `workspace.fs` proxies to the renderer's `ctx.fs.*` (which is permission-
 * gated). `workspace.getConfiguration` reads from cognia settings.
 * `workspace.textDocuments` + `onDidOpenTextDocument` reflect Monaco editor
 * state pushed by the renderer.
 */

import { Disposable, EventEmitter, Uri, type CancellationToken, type WorkspaceEdit } from "./types"
import type { ShimDependencies } from "./index"

export function createWorkspaceNamespace(deps: ShimDependencies) {
  const { connection, extensionId } = deps
  const documents = deps.documents
  const didChangeConfig = new EventEmitter<{ affectsConfiguration: (key: string) => boolean }>()
  let workspaceFolders: ReadonlyArray<{ uri: Uri; name: string; index: number }> = []
  connection.onNotification("workspace:configurationChanged", (data) =>
    didChangeConfig.fire(data as { affectsConfiguration: (key: string) => boolean })
  )
  connection.onNotification("workspace:foldersChanged", (params) => {
    workspaceFolders = (params as typeof workspaceFolders) ?? []
  })

  return {
    get workspaceFolders() {
      return workspaceFolders
    },
    get textDocuments() {
      return documents.all()
    },
    get isTrusted() {
      // cognia always treats extensions as trusted within the sandbox —
      // the cognia permission gate is the actual trust boundary.
      return true
    },
    name: "cognia",
    onDidGrantWorkspaceTrust(listener: () => void) {
      // Synchronous fire — cognia never revokes trust.
      queueMicrotask(listener)
      return new Disposable(() => {})
    },
    onDidOpenTextDocument: documents.onDidOpen.event,
    onDidChangeTextDocument: documents.onDidChange.event,
    onDidSaveTextDocument: documents.onDidSave.event,
    onDidCloseTextDocument: documents.onDidClose.event,
    onDidChangeConfiguration(
      listener: (e: { affectsConfiguration: (k: string) => boolean }) => void
    ) {
      return didChangeConfig.event(listener)
    },
    /**
     * A file path or URI, or `{ content, language }` (or nothing) for a new
     * untitled document. An open document is answered here; anything else
     * the renderer opens, and its report puts it in the store first.
     */
    async openTextDocument(uriOrOptions?: Uri | string | { content?: string; language?: string }) {
      const uri =
        typeof uriOrOptions === "string"
          ? Uri.file(uriOrOptions).toString()
          : uriOrOptions instanceof Uri
            ? uriOrOptions.toString()
            : undefined
      const open = uri ? documents.get(uri) : undefined
      if (open) return open
      const options =
        uri === undefined
          ? (uriOrOptions as { content?: string; language?: string } | undefined)
          : undefined
      const opened = await connection.sendRequest<{ uri: string; version: number }>(
        "workspace:openTextDocument",
        uri
          ? { extensionId, uri }
          : {
              extensionId,
              untitled: {
                ...(options?.content !== undefined ? { content: options.content } : {}),
                ...(options?.language !== undefined ? { language: options.language } : {}),
              },
            }
      )
      const document = await documents.waitForVersion(opened.uri, opened.version)
      if (!document) throw new Error(`Could not open ${opened.uri}`)
      return document
    },
    getConfiguration(section?: string, scope?: unknown) {
      return new ProxyConfiguration(connection, extensionId, section, scope)
    },
    findFiles(pattern: string, exclude?: string, maxResults?: number) {
      return connection.sendRequest("workspace:findFiles", {
        extensionId,
        pattern,
        exclude,
        maxResults,
      })
    },
    createFileSystemWatcher(globPattern: string) {
      const handle = `fsw:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
      const createEmitter = new EventEmitter<Uri>()
      const changeEmitter = new EventEmitter<Uri>()
      const deleteEmitter = new EventEmitter<Uri>()
      connection.onNotification(`fsw:${handle}:create`, (uri) => createEmitter.fire(uri as Uri))
      connection.onNotification(`fsw:${handle}:change`, (uri) => changeEmitter.fire(uri as Uri))
      connection.onNotification(`fsw:${handle}:delete`, (uri) => deleteEmitter.fire(uri as Uri))
      void connection.sendRequest("workspace:createFileSystemWatcher", {
        extensionId,
        handle,
        globPattern,
      })
      return {
        onDidCreate: createEmitter.event,
        onDidChange: changeEmitter.event,
        onDidDelete: deleteEmitter.event,
        dispose: () => {
          createEmitter.dispose()
          changeEmitter.dispose()
          deleteEmitter.dispose()
          void connection.sendNotification("workspace:disposeFileSystemWatcher", { handle })
        },
      }
    },
    fs: {
      readFile: (uri: Uri) => connection.sendRequest("fs:readFile", { extensionId, uri }),
      writeFile: (uri: Uri, content: Uint8Array) =>
        connection.sendRequest("fs:writeFile", { extensionId, uri, content }),
      delete: (uri: Uri, options?: { recursive?: boolean }) =>
        connection.sendRequest("fs:delete", { extensionId, uri, options }),
      rename: (oldUri: Uri, newUri: Uri) =>
        connection.sendRequest("fs:rename", { extensionId, oldUri, newUri }),
      copy: (source: Uri, target: Uri, options?: { overwrite?: boolean }) =>
        connection.sendRequest("fs:copy", { extensionId, source, target, options }),
      stat: (uri: Uri) => connection.sendRequest("fs:stat", { extensionId, uri }),
      readDirectory: (uri: Uri) => connection.sendRequest("fs:readDirectory", { extensionId, uri }),
      createDirectory: (uri: Uri) =>
        connection.sendRequest("fs:createDirectory", { extensionId, uri }),
    },
    /**
     * Resolves once every document the edit changed shows it here, as in VS
     * Code; `false` when a step failed (the reason is in the extension's log).
     */
    async applyEdit(edit: WorkspaceEdit | { toJSON(): unknown }): Promise<boolean> {
      const result = await connection.sendRequest<{
        applied: boolean
        versions: Record<string, number>
      }>("workspace:applyEdit", { extensionId, edit: edit.toJSON() })
      await Promise.all(
        Object.entries(result.versions ?? {}).map(([uri, version]) =>
          documents.waitForVersion(uri, version)
        )
      )
      return result.applied
    },
    /** Save the document at `uri`; its URI once saved, `undefined` otherwise. */
    async save(uri: Uri): Promise<Uri | undefined> {
      const saved = await connection.sendRequest<boolean>("workspace:saveTextDocument", {
        extensionId,
        uri: uri.toString(),
      })
      return saved ? uri : undefined
    },
    saveAll(includeUntitled?: boolean): Promise<boolean> {
      return connection.sendRequest<boolean>("workspace:saveAll", {
        extensionId,
        includeUntitled: includeUntitled === true,
      })
    },
    registerTextDocumentContentProvider(
      scheme: string,
      provider: {
        provideTextDocumentContent: (
          uri: Uri,
          token: CancellationToken
        ) => string | null | undefined | Promise<string | null | undefined>
        onDidChange?: (listener: (uri: Uri) => void) => { dispose(): void }
      }
    ) {
      const token = `tdcp:${extensionId}:${scheme}:${Math.random().toString(36).slice(2, 10)}`
      const unregisterCallback = deps.registerProviderCallback(token, async (payload, call) =>
        provider.provideTextDocumentContent(
          Uri.parse(String((payload as { uri: string }).uri)),
          call.cancellation
        )
      )
      void connection.sendRequest("workspace:registerTextDocumentContentProvider", {
        extensionId,
        scheme,
        token,
      })
      // The provider's own change event refreshes every copy of that document.
      const changes = provider.onDidChange?.((uri) => {
        void connection.sendNotification("workspace:textDocumentContentChanged", {
          extensionId,
          scheme,
          uri: uri.toString(),
        })
      })
      return new Disposable(() => {
        changes?.dispose()
        unregisterCallback()
        void connection.sendNotification("workspace:unregisterTextDocumentContentProvider", {
          extensionId,
          scheme,
          token,
        })
      })
    },
  }
}

class ProxyConfiguration {
  constructor(
    private readonly connection: ShimDependencies["connection"],
    private readonly extensionId: string,
    private readonly section: string | undefined,
    private readonly scope: unknown
  ) {}
  get<T>(key: string, defaultValue?: T): T | undefined {
    // VS Code's getConfiguration is synchronous, but our shim is async at
    // its core. We expose both: callers using the sync API get undefined
    // until they re-read after a `.refresh()`. Most extensions read once
    // at activate, which still works because the renderer pushes initial
    // values before activate.
    void this.connection
      .sendRequest<T | undefined>("workspace:configurationGet", {
        extensionId: this.extensionId,
        section: this.section,
        key,
        scope: this.scope,
      })
      .catch(() => undefined)
    return defaultValue
  }
  has(key: string): boolean {
    void this.connection
      .sendRequest<boolean>("workspace:configurationHas", {
        extensionId: this.extensionId,
        section: this.section,
        key,
      })
      .catch(() => false)
    return false
  }
  update(key: string, value: unknown, configurationTarget?: number): Promise<void> {
    return this.connection.sendRequest("workspace:configurationUpdate", {
      extensionId: this.extensionId,
      section: this.section,
      key,
      value,
      configurationTarget,
    })
  }
  inspect<T>(key: string): T | undefined {
    void this.connection
      .sendRequest<T | undefined>("workspace:configurationInspect", {
        extensionId: this.extensionId,
        section: this.section,
        key,
      })
      .catch(() => undefined)
    return undefined
  }
}
