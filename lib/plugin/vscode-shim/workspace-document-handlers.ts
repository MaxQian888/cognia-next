/**
 * Renderer side of `vscode.workspace`'s documents and `window.showTextDocument`:
 *
 *   - `workspace:openTextDocument` gives the asking host the document. One an
 *     editor shows is already there; a file is read from the workspace
 *     (`filesystem:read`), an untitled document starts empty or with the
 *     given content, and any other scheme asks the extension that registered
 *     a content provider for it. Those are detached documents only the
 *     asking host sees (see `document-sync.ts`).
 *   - `workspace:applyEdit` applies text edits and file operations in the
 *     order the extension added them: text edits to a document an editor
 *     shows go through Monaco (undoable, left unsaved, as in VS Code); edits
 *     to other files, and every file operation, change the files on disk
 *     and need `filesystem:write`.
 *   - `workspace:saveTextDocument` / `workspace:saveAll` save through the
 *     project editor, which also reports the user's own saves back as
 *     `onDidSaveTextDocument`.
 *   - `window:showTextDocument` opens a file in the project editor.
 *
 * Not supported, and answered as such: saving an untitled document (VS Code
 * asks for a file name; nothing here can) and showing a document that is
 * not a file in the open project.
 */

import { fileUriToPath, pathToFileUri } from "@/lib/files/path-uri"
import {
  flushProjectEditorEdits,
  onProjectFileSaved,
  openInProjectEditor,
  saveInProjectEditor,
} from "@/lib/files/project-editor-bridge"
import {
  deleteWorkspaceEntry,
  listWorkspaceRoots,
  readWorkspaceFile,
  renameWorkspaceEntry,
  statWorkspaceFile,
  writeWorkspaceFile,
} from "@/lib/files/workspace-fs"
import { languageFromPath } from "@/lib/git/language-map"
import { detectLanguage } from "@/lib/plugin/bridge/languages-bridge"
import { listPluginPermissions } from "@/lib/plugin/core/transport"

import { appendVscodeLog } from "./vscode-log-buffer"
import type { DocumentSync } from "./document-sync"
import { applyDocumentEdits, type EditOutcome } from "./monaco-bridge"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { applyTextEdits, type PlainTextEdit } from "./text-edits"

/** Send a request to one extension host. */
export type SendToHost = (pluginId: string, method: string, payload: unknown) => Promise<unknown>

export interface VscodeDocumentsDependencies {
  sync: DocumentSync
  sendToHost: SendToHost
  /** The permissions the user granted the extension. */
  permissions(pluginId: string): Promise<readonly string[]>
  /** File URI ↔ absolute path, in the form Monaco's file models use. */
  pathOf(uri: string): string | null
  uriOf(path: string): string
  /** The workspace's files, addressed as root + relative path. */
  fs: {
    roots(): Promise<string[]>
    read(root: string, relPath: string): Promise<string>
    write(root: string, relPath: string, text: string): Promise<void>
    stat(root: string, relPath: string): Promise<{ exists: boolean; isDir: boolean }>
    remove(root: string, relPath: string, recursive: boolean): Promise<void>
    rename(root: string, fromRelPath: string, toRelPath: string): Promise<void>
  }
  editor: {
    /** Open a file in the project editor at a 1-based line/column; `false` when none is rooted there. */
    open(path: string, line?: number, column?: number): boolean
    /** Save one open file; `null` when no editor there saves single files. */
    save(path: string): Promise<boolean | null>
    /** Save every editor's drafts; the paths that could not be saved. */
    saveAll(): Promise<string[]>
    /** The project editor saved a file. */
    onSaved(listener: (path: string) => void): () => void
  }
  /** Apply text edits to the document an editor shows at `uri`; `null` when none does. */
  applyDocumentEdits(req: { uri: string; edits: PlainTextEdit[]; eol?: number }): EditOutcome | null
  /** The language id for a file path. */
  languageOf(path: string): string
}

/** The real dependencies: the workspace's files, the project editor and Monaco. */
export function createVscodeDocumentsDependencies(
  sync: DocumentSync,
  sendToHost: SendToHost
): VscodeDocumentsDependencies {
  return {
    sync,
    sendToHost,
    permissions: (pluginId) => listPluginPermissions(pluginId),
    pathOf: fileUriToPath,
    uriOf: pathToFileUri,
    fs: {
      roots: async () => (await listWorkspaceRoots()).map((root) => root.path),
      read: (root, relPath) => readWorkspaceFile(root, relPath),
      write: (root, relPath, text) => writeWorkspaceFile(root, relPath, text),
      stat: async (root, relPath) => {
        const stat = await statWorkspaceFile(root, relPath)
        return { exists: stat.exists, isDir: stat.isDir }
      },
      remove: (root, relPath, recursive) => deleteWorkspaceEntry(root, relPath, recursive),
      rename: (root, fromRelPath, toRelPath) => renameWorkspaceEntry(root, fromRelPath, toRelPath),
    },
    editor: {
      open: openInProjectEditor,
      save: saveInProjectEditor,
      saveAll: flushProjectEditorEdits,
      onSaved: onProjectFileSaved,
    },
    applyDocumentEdits,
    languageOf: (path) => detectLanguage(path) ?? languageFromPath(path),
  }
}

let deps: VscodeDocumentsDependencies | null = null
let unsubscribeSaved: (() => void) | null = null

/** A content provider an extension registered for a scheme. */
interface ContentProvider {
  pluginId: string
  token: string
}
const contentProviders = new Map<string, ContentProvider[]>()
const untitledCounters = new Map<string, number>()

/** Schemes a content provider cannot take: their documents come from elsewhere. */
const RESERVED_SCHEMES = new Set(["file", "untitled"])

export function configureVscodeDocuments(next: VscodeDocumentsDependencies | null): void {
  unsubscribeSaved?.()
  unsubscribeSaved = null
  deps = next
  if (next) {
    unsubscribeSaved = next.editor.onSaved((path) => next.sync.saved(next.uriOf(path)))
  }
}

function requireDeps(): VscodeDocumentsDependencies {
  if (!deps) throw new Error("VS Code documents are not available before the editor bridge starts")
  return deps
}

function object(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  return payload as Record<string, unknown>
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  const value = object(payload)
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

function schemeOf(uri: string): string {
  const colon = uri.indexOf(":")
  return colon > 0 ? uri.slice(0, colon).toLowerCase() : ""
}

async function requirePermission(pluginId: string, permission: string): Promise<void> {
  const granted = await requireDeps().permissions(pluginId)
  if (!granted.includes(permission)) {
    throw new Error(`VS Code extension ${pluginId} requires permission ${permission}`)
  }
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")

/** A file path as the workspace root holding it plus the path inside it. */
async function locate(path: string): Promise<{ root: string; relPath: string }> {
  const target = normalize(path)
  let best: string | null = null
  for (const root of await requireDeps().fs.roots()) {
    const base = normalize(root)
    if (
      (target === base || target.startsWith(`${base}/`)) &&
      (!best || base.length > best.length)
    ) {
      best = base
    }
  }
  if (!best || target === best) {
    throw new Error(`${path} is not a file in the open workspace`)
  }
  return { root: best, relPath: target.slice(best.length + 1) }
}

/** A file URI's path, or an error naming what the operation needs. */
function filePath(uri: string, operation: string): string {
  const path = requireDeps().pathOf(uri)
  if (!path) throw new Error(`${operation} works on files; ${uri} is not one`)
  return path
}

/** The canonical form of a file URI (Monaco's), so hosts key one document once. */
function canonical(uri: string): string {
  const { pathOf, uriOf } = requireDeps()
  const path = pathOf(uri)
  return path ? uriOf(path) : uri
}

async function provideContent(uri: string): Promise<string> {
  const scheme = schemeOf(uri)
  const providers = contentProviders.get(scheme) ?? []
  if (providers.length === 0) {
    throw new Error(`No text document content provider is registered for "${scheme}"`)
  }
  // As in VS Code, the first provider that answers wins.
  for (const provider of providers) {
    const text = await requireDeps().sendToHost(provider.pluginId, "extension:call", {
      token: provider.token,
      method: "provideTextDocumentContent",
      payload: { uri },
    })
    if (typeof text === "string") return text
  }
  throw new Error(`No content provider for "${scheme}" produced ${uri}`)
}

async function openDocument(
  pluginId: string,
  request: { uri?: string; untitled?: { content?: string; language?: string } }
): Promise<{ uri: string; version: number }> {
  const { sync } = requireDeps()
  if (!request.uri) {
    const count = (untitledCounters.get(pluginId) ?? 0) + 1
    untitledCounters.set(pluginId, count)
    const uri = `untitled:Untitled-${count}`
    const version = await sync.openDetached(
      pluginId,
      uri,
      request.untitled?.language || "plaintext",
      request.untitled?.content ?? ""
    )
    return { uri, version }
  }
  const uri = canonical(request.uri)
  const shown = sync.editorDocument(uri)
  if (shown) return { uri, version: shown.version }
  const held = sync.detached(pluginId, uri)
  if (held) return { uri, version: held.version }

  const scheme = schemeOf(uri)
  if (scheme === "untitled") {
    return { uri, version: await sync.openDetached(pluginId, uri, "plaintext", "") }
  }
  if (scheme === "file") {
    await requirePermission(pluginId, "filesystem:read")
    const path = filePath(uri, "Opening a document")
    const { root, relPath } = await locate(path)
    const stat = await requireDeps().fs.stat(root, relPath)
    if (!stat.exists) throw new Error(`Cannot open ${uri}: the file does not exist`)
    if (stat.isDir) throw new Error(`Cannot open ${uri}: it is a directory`)
    const text = await requireDeps().fs.read(root, relPath)
    const version = await sync.openDetached(pluginId, uri, requireDeps().languageOf(path), text)
    return { uri, version }
  }
  const text = await provideContent(uri)
  return { uri, version: await sync.openDetached(pluginId, uri, "plaintext", text) }
}

type WireOperation =
  | { kind: "edit"; uri: string; edits: PlainTextEdit[]; eol?: number }
  | {
      kind: "create"
      uri: string
      options?: { overwrite?: boolean; ignoreIfExists?: boolean }
      contents?: { text?: string; binary?: boolean }
    }
  | {
      kind: "rename"
      oldUri: string
      newUri: string
      options?: { overwrite?: boolean; ignoreIfExists?: boolean }
    }
  | {
      kind: "delete"
      uri: string
      options?: { recursive?: boolean; ignoreIfNotExists?: boolean }
    }

function readOperations(edit: unknown): WireOperation[] {
  const operations = object(edit).operations
  if (!Array.isArray(operations)) throw new Error("workspace:applyEdit requires edit.operations")
  return operations.map((operation) => {
    const value = object(operation)
    switch (value.kind) {
      case "edit":
        if (!Array.isArray(value.edits)) throw new Error("A text edit step requires edits")
        return {
          kind: "edit",
          uri: canonical(requiredString(value, "uri")),
          edits: value.edits as PlainTextEdit[],
          ...(typeof value.eol === "number" ? { eol: value.eol } : {}),
        }
      case "create":
      case "delete":
        return { ...value, uri: canonical(requiredString(value, "uri")) } as WireOperation
      case "rename":
        return {
          ...value,
          oldUri: canonical(requiredString(value, "oldUri")),
          newUri: canonical(requiredString(value, "newUri")),
        } as WireOperation
      default:
        throw new Error(`Unknown workspace edit step ${String(value.kind)}`)
    }
  })
}

/** Whether a step changes files on disk (and so needs `filesystem:write`). */
function touchesDisk(pluginId: string, operation: WireOperation): boolean {
  if (operation.kind !== "edit") return true
  const { sync } = requireDeps()
  if (sync.editorDocument(operation.uri)) return false
  return schemeOf(operation.uri) === "file" || !sync.detached(pluginId, operation.uri)
}

async function replaceHeldCopies(uri: string, text: string): Promise<void> {
  const { sync } = requireDeps()
  await Promise.all(
    sync.detachedHolders(uri).map((holder) => sync.changeDetached(holder, uri, text))
  )
}

function closeHeldCopies(uri: string): void {
  const { sync } = requireDeps()
  for (const holder of sync.detachedHolders(uri)) sync.closeDetached(holder, uri)
}

async function applyStep(
  pluginId: string,
  operation: WireOperation,
  versions: Record<string, number>
): Promise<void> {
  const { sync, fs, applyDocumentEdits } = requireDeps()
  switch (operation.kind) {
    case "edit": {
      const shown = applyDocumentEdits({
        uri: operation.uri,
        edits: operation.edits,
        ...(operation.eol !== undefined ? { eol: operation.eol } : {}),
      })
      if (shown) {
        if (!shown.applied) throw new Error(`The editor on ${operation.uri} refused the edit`)
        if (shown.version !== undefined) versions[operation.uri] = shown.version
        return
      }
      if (schemeOf(operation.uri) !== "file") {
        const held = sync.detached(pluginId, operation.uri)
        if (!held) throw new Error(`${operation.uri} is not open`)
        const version = await sync.changeDetached(
          pluginId,
          operation.uri,
          applyTextEdits(held.text, operation.edits, operation.eol)
        )
        if (version !== undefined) versions[operation.uri] = version
        return
      }
      const { root, relPath } = await locate(filePath(operation.uri, "Editing a file"))
      const text = applyTextEdits(await fs.read(root, relPath), operation.edits, operation.eol)
      await fs.write(root, relPath, text)
      await replaceHeldCopies(operation.uri, text)
      const held = sync.detached(pluginId, operation.uri)
      if (held) versions[operation.uri] = held.version
      return
    }
    case "create": {
      if (operation.contents?.binary) {
        throw new Error(`Creating ${operation.uri} with binary contents is not supported`)
      }
      const text = operation.contents?.text ?? ""
      const { root, relPath } = await locate(filePath(operation.uri, "Creating a file"))
      const stat = await fs.stat(root, relPath)
      if (stat.exists) {
        if (operation.options?.overwrite) {
          if (stat.isDir) await fs.remove(root, relPath, true)
        } else if (operation.options?.ignoreIfExists) {
          return
        } else {
          throw new Error(`Cannot create ${operation.uri}: it already exists`)
        }
      }
      await fs.write(root, relPath, text)
      await replaceHeldCopies(operation.uri, text)
      return
    }
    case "rename": {
      const from = await locate(filePath(operation.oldUri, "Renaming a file"))
      const to = await locate(filePath(operation.newUri, "Renaming a file"))
      if (from.root !== to.root) {
        throw new Error(`Cannot move ${operation.oldUri} to another workspace folder`)
      }
      const source = await fs.stat(from.root, from.relPath)
      if (!source.exists) throw new Error(`Cannot rename ${operation.oldUri}: it does not exist`)
      const target = await fs.stat(to.root, to.relPath)
      if (target.exists) {
        if (operation.options?.overwrite) await fs.remove(to.root, to.relPath, true)
        else if (operation.options?.ignoreIfExists) return
        else throw new Error(`Cannot rename to ${operation.newUri}: it already exists`)
      }
      await fs.rename(from.root, from.relPath, to.relPath)
      closeHeldCopies(operation.oldUri)
      closeHeldCopies(operation.newUri)
      return
    }
    case "delete": {
      const { root, relPath } = await locate(filePath(operation.uri, "Deleting a file"))
      const stat = await fs.stat(root, relPath)
      if (!stat.exists) {
        if (operation.options?.ignoreIfNotExists) return
        throw new Error(`Cannot delete ${operation.uri}: it does not exist`)
      }
      await fs.remove(root, relPath, operation.options?.recursive === true)
      closeHeldCopies(operation.uri)
      return
    }
  }
}

async function applyWorkspaceEdit(
  pluginId: string,
  edit: unknown
): Promise<{ applied: boolean; versions: Record<string, number> }> {
  const operations = readOperations(edit)
  if (operations.some((operation) => touchesDisk(pluginId, operation))) {
    await requirePermission(pluginId, "filesystem:read")
    await requirePermission(pluginId, "filesystem:write")
  }
  const versions: Record<string, number> = {}
  for (const operation of operations) {
    try {
      await applyStep(pluginId, operation, versions)
    } catch (error) {
      // As in VS Code, a failed edit resolves `false`; the reason goes to the
      // extension's log. Steps already applied stay applied.
      appendVscodeLog(pluginId, {
        level: "warn",
        kind: "workspace-edit",
        message: `workspace.applyEdit stopped: ${error instanceof Error ? error.message : String(error)}`,
      })
      return { applied: false, versions }
    }
  }
  return { applied: true, versions }
}

async function saveDocument(pluginId: string, uri: string): Promise<boolean> {
  const { sync, editor, fs } = requireDeps()
  const key = canonical(uri)
  if (schemeOf(key) === "untitled") {
    appendVscodeLog(pluginId, {
      level: "warn",
      kind: "workspace-save",
      message: `Saving untitled document ${key} is not supported: there is no file to save it to`,
    })
    return false
  }
  const shown = sync.editorDocument(key)
  if (!shown) {
    // A detached file is written through on every edit; anything else has
    // nowhere to be saved.
    return schemeOf(key) === "file" && sync.detached(pluginId, key) !== undefined
  }
  const path = requireDeps().pathOf(key)
  if (!path) return false
  const saved = await editor.save(path)
  if (saved !== null) return saved
  // No project editor owns it: write the editor's text ourselves.
  await requirePermission(pluginId, "filesystem:write")
  const { root, relPath } = await locate(path)
  await fs.write(root, relPath, shown.text)
  sync.saved(key)
  return true
}

export function installVscodeDocumentHandlers(): Array<() => void> {
  const disposers: Array<() => void> = []
  const on = (method: string, handler: Parameters<typeof registerMethod>[1]) =>
    disposers.push(registerMethod(method, handler))

  on("workspace:openTextDocument", async (payload, context) => {
    const value = owned(payload, context)
    const untitled =
      value.untitled && typeof value.untitled === "object"
        ? (value.untitled as { content?: unknown; language?: unknown })
        : undefined
    return openDocument(context.pluginId, {
      ...(typeof value.uri === "string" && value.uri ? { uri: value.uri } : {}),
      ...(untitled
        ? {
            untitled: {
              ...(typeof untitled.content === "string" ? { content: untitled.content } : {}),
              ...(typeof untitled.language === "string" ? { language: untitled.language } : {}),
            },
          }
        : {}),
    })
  })

  on("workspace:applyEdit", async (payload, context) => {
    const value = owned(payload, context)
    return applyWorkspaceEdit(context.pluginId, value.edit)
  })

  on("workspace:saveTextDocument", async (payload, context) => {
    const value = owned(payload, context)
    return saveDocument(context.pluginId, requiredString(value, "uri"))
  })

  on("workspace:saveAll", async (payload, context) => {
    const value = owned(payload, context)
    const failed = await requireDeps().editor.saveAll()
    for (const path of failed) {
      appendVscodeLog(context.pluginId, {
        level: "warn",
        kind: "workspace-save",
        message: `workspace.saveAll could not save ${path}`,
      })
    }
    // Untitled documents cannot be saved here (see the module comment).
    const untitledLeft =
      value.includeUntitled === true &&
      requireDeps()
        .sync.heldBy(context.pluginId)
        .some((uri) => schemeOf(uri) === "untitled")
    return failed.length === 0 && !untitledLeft
  })

  on("workspace:registerTextDocumentContentProvider", (payload, context) => {
    const value = owned(payload, context)
    const scheme = requiredString(value, "scheme").toLowerCase()
    const token = requiredString(value, "token")
    if (RESERVED_SCHEMES.has(scheme)) {
      throw new Error(`The scheme "${scheme}" cannot have a content provider`)
    }
    const providers = (contentProviders.get(scheme) ?? []).filter(
      (provider) => provider.token !== token
    )
    providers.push({ pluginId: context.pluginId, token })
    contentProviders.set(scheme, providers)
    return null
  })

  on("workspace:unregisterTextDocumentContentProvider", (payload, context) => {
    const value = owned(payload, context)
    const scheme = requiredString(value, "scheme").toLowerCase()
    const token = typeof value.token === "string" ? value.token : undefined
    const left = (contentProviders.get(scheme) ?? []).filter(
      (provider) =>
        provider.pluginId !== context.pluginId || (token !== undefined && provider.token !== token)
    )
    if (left.length > 0) contentProviders.set(scheme, left)
    else contentProviders.delete(scheme)
    return null
  })

  on("workspace:textDocumentContentChanged", async (payload, context) => {
    const value = owned(payload, context)
    const uri = requiredString(value, "uri")
    const scheme = schemeOf(uri)
    if (!(contentProviders.get(scheme) ?? []).some((p) => p.pluginId === context.pluginId)) {
      throw new Error(`${context.pluginId} has no content provider for "${scheme}"`)
    }
    if (requireDeps().sync.detachedHolders(uri).length === 0) return null
    await replaceHeldCopies(uri, await provideContent(uri))
    return null
  })

  on("window:showTextDocument", (payload, context) => {
    const value = owned(payload, context)
    const uri = canonical(requiredString(value, "uri"))
    const path = requireDeps().pathOf(uri)
    if (!path) {
      throw new Error(`Only files can be shown in an editor here; ${uri} is not one`)
    }
    const selection =
      value.selection && typeof value.selection === "object"
        ? (value.selection as { start?: { line?: number; character?: number } })
        : undefined
    const line = selection?.start?.line
    const character = selection?.start?.character
    const opened = requireDeps().editor.open(
      path,
      typeof line === "number" ? line + 1 : undefined,
      typeof character === "number" ? character + 1 : undefined
    )
    if (!opened) throw new Error(`No project editor is open for ${path}`)
    return { uri }
  })

  return disposers
}

/** Forget a stopped extension's content providers and untitled numbering. */
export function clearVscodeDocumentsForPlugin(pluginId: string): void {
  for (const [scheme, providers] of contentProviders) {
    const left = providers.filter((provider) => provider.pluginId !== pluginId)
    if (left.length > 0) contentProviders.set(scheme, left)
    else contentProviders.delete(scheme)
  }
  untitledCounters.delete(pluginId)
}

export function __resetVscodeDocumentsForTesting(): void {
  configureVscodeDocuments(null)
  contentProviders.clear()
  untitledCounters.clear()
}
