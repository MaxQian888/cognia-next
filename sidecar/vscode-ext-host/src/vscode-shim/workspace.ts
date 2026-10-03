/**
 * `vscode.workspace` — folders, files, configuration, document lifecycle.
 *
 * Folders and file-watcher events come from the renderer (`workspace-folders.ts`);
 * `workspace.fs` works on files in the host once the renderer has authorized
 * each path (`workspace-fs.ts`); `findFiles` asks the renderer, which walks
 * the folders. `workspace.textDocuments` + `onDidOpenTextDocument` reflect
 * Monaco editor state pushed by the renderer.
 */

import { Disposable, EventEmitter, Uri, type CancellationToken, type WorkspaceEdit } from "./types"
import type { ShimDependencies } from "./index"
import { createWorkspaceConfiguration } from "./configuration"
import { createWorkspaceFileSystem } from "./workspace-fs"
import type { FileSystemEventKind } from "./workspace-folders"

/** A `GlobPattern`: a glob string, or a `RelativePattern` (`{ baseUri | base, pattern }`). */
type GlobPattern = string | { baseUri?: Uri; base?: string; pattern: string }

/** A glob pattern as the renderer takes it: the base (a URI) and the glob relative to it. */
function wireGlob(pattern: GlobPattern): { base?: string; pattern: string } {
  if (typeof pattern === "string") return { pattern }
  if (!pattern || typeof pattern.pattern !== "string") {
    throw new TypeError("A glob pattern is a string or a RelativePattern")
  }
  const base = pattern.baseUri ?? (pattern.base !== undefined ? Uri.file(pattern.base) : undefined)
  return { ...(base ? { base: base.toString() } : {}), pattern: pattern.pattern }
}

export function createWorkspaceNamespace(deps: ShimDependencies) {
  const { connection, extensionId, folders } = deps
  const documents = deps.documents
  const fileSystem = createWorkspaceFileSystem({
    connection,
    extensionId,
    ownedPaths: deps.ownedPaths,
  })

  return {
    get workspaceFolders() {
      return folders.folders
    },
    /** The first folder's name, or `undefined` with none open. */
    get name() {
      return folders.folders?.[0]?.name
    },
    /** Deprecated in VS Code: the first folder's path. */
    get rootPath() {
      return folders.folders?.[0]?.uri.fsPath
    },
    /** There are no `.code-workspace` files here. */
    workspaceFile: undefined,
    onDidChangeWorkspaceFolders: folders.onDidChange.event,
    getWorkspaceFolder: (uri: Uri) => folders.getWorkspaceFolder(uri),
    asRelativePath: (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean) =>
      folders.asRelativePath(pathOrUri, includeWorkspaceFolder),
    /**
     * The folders are the projects open in the app's editors, which the
     * extension cannot change: answers `false` (not applied), as VS Code
     * does for an edit it refuses.
     */
    updateWorkspaceFolders(): boolean {
      return false
    },
    get textDocuments() {
      return documents.all()
    },
    get isTrusted() {
      // cognia always treats extensions as trusted within the sandbox —
      // the cognia permission gate is the actual trust boundary.
      return true
    },
    onDidGrantWorkspaceTrust(listener: () => void) {
      // Synchronous fire — cognia never revokes trust.
      queueMicrotask(listener)
      return new Disposable(() => {})
    },
    onDidOpenTextDocument: documents.onDidOpen.event,
    onDidChangeTextDocument: documents.onDidChange.event,
    onDidSaveTextDocument: documents.onDidSave.event,
    onDidCloseTextDocument: documents.onDidClose.event,
    onDidChangeConfiguration: deps.configuration.onDidChange.event,
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
    /**
     * The settings under `section`. `scope` (a resource or language) selects
     * nothing: there are no folder- or language-specific values here.
     */
    getConfiguration(section?: string, _scope?: unknown) {
      return createWorkspaceConfiguration({
        store: deps.configuration,
        connection,
        extensionId,
        ...(section ? { section } : {}),
      })
    },
    /**
     * Files in the open folders matching `include`, matched against each
     * file's path inside its folder. `exclude` `undefined` applies the
     * default excludes (`.git` and the like), `null` none. Ignore files
     * (`.gitignore`) are not applied, as in VS Code.
     */
    async findFiles(
      include: GlobPattern,
      exclude?: GlobPattern | null,
      maxResults?: number,
      token?: CancellationToken
    ): Promise<Uri[]> {
      if (token?.isCancellationRequested) return []
      const search = connection.sendRequest<string[]>("workspace:findFiles", {
        extensionId,
        include: wireGlob(include),
        exclude: exclude === undefined ? undefined : exclude === null ? null : wireGlob(exclude),
        ...(maxResults !== undefined ? { maxResults } : {}),
      })
      const found = token
        ? await Promise.race([
            search,
            new Promise<null>((resolve) => token.onCancellationRequested(() => resolve(null))),
          ])
        : await search
      return found === null || token?.isCancellationRequested
        ? []
        : found.map((uri) => Uri.parse(uri))
    },
    /**
     * Events for files in the open folders matching `globPattern` (a string
     * glob is matched against the whole path, a `RelativePattern` inside
     * its base). The renderer runs the watch; one it cannot run (no
     * permission, a base outside the folders) says why in the extension's
     * log and stays silent.
     */
    createFileSystemWatcher(
      globPattern: GlobPattern,
      ignoreCreateEvents = false,
      ignoreChangeEvents = false,
      ignoreDeleteEvents = false
    ) {
      const handle = `fsw:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
      const emitters: Record<FileSystemEventKind, EventEmitter<Uri>> = {
        create: new EventEmitter<Uri>(),
        change: new EventEmitter<Uri>(),
        delete: new EventEmitter<Uri>(),
      }
      const removeSink = folders.addWatcher(handle, (kind, uri) => emitters[kind].fire(uri))
      void connection
        .sendRequest("workspace:createFileSystemWatcher", {
          extensionId,
          handle,
          pattern: wireGlob(globPattern),
          ignoreCreateEvents,
          ignoreChangeEvents,
          ignoreDeleteEvents,
        })
        .catch(() => undefined)
      return {
        ignoreCreateEvents,
        ignoreChangeEvents,
        ignoreDeleteEvents,
        onDidCreate: emitters.create.event,
        onDidChange: emitters.change.event,
        onDidDelete: emitters.delete.event,
        dispose: () => {
          removeSink()
          for (const emitter of Object.values(emitters)) emitter.dispose()
          void connection.sendNotification("workspace:disposeFileSystemWatcher", {
            extensionId,
            handle,
          })
        },
      }
    },
    fs: fileSystem,
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
