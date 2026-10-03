/**
 * The workspace folders the extension sees, and its file watchers' events.
 *
 * The renderer owns both: it reports the open project folders
 * (`workspace:foldersChanged`, before activation and on every change) and
 * delivers the events of the watchers it runs for the extension
 * (`workspace:fileSystemEvents`). This store keeps the folders so
 * `workspace.workspaceFolders`, `getWorkspaceFolder` and `asRelativePath`
 * answer synchronously, as in VS Code, and routes each event to its watcher.
 */

import type { RpcConnection } from "../rpc"
import { EventEmitter, Uri } from "./types"

export interface WorkspaceFolder {
  readonly uri: Uri
  readonly name: string
  readonly index: number
}

export interface WorkspaceFoldersChangeEvent {
  readonly added: readonly WorkspaceFolder[]
  readonly removed: readonly WorkspaceFolder[]
}

export type FileSystemEventKind = "create" | "change" | "delete"

/** One watcher's event sink. */
export type WatcherSink = (kind: FileSystemEventKind, uri: Uri) => void

function contains(folder: Uri, uri: Uri): boolean {
  if (folder.scheme !== uri.scheme || folder.authority !== uri.authority) return false
  const base = folder.path.replace(/\/+$/, "")
  return uri.path === base || uri.path.startsWith(`${base}/`)
}

export class WorkspaceFolders {
  private list: WorkspaceFolder[] = []
  private readonly watchers = new Map<string, WatcherSink>()
  readonly onDidChange = new EventEmitter<WorkspaceFoldersChangeEvent>()

  attach(connection: RpcConnection): void {
    connection.onRequest("workspace:foldersChanged", (params) => {
      const { folders } = params as { folders: Array<{ uri: string; name: string }> }
      this.set(Array.isArray(folders) ? folders : [])
      return null
    })
    connection.onRequest("workspace:fileSystemEvents", (params) => {
      const { handle, events } = params as {
        handle: string
        events: Array<{ kind: FileSystemEventKind; uri: string }>
      }
      const sink = this.watchers.get(handle)
      if (sink) for (const event of events ?? []) sink(event.kind, Uri.parse(event.uri))
      return null
    })
  }

  set(wire: Array<{ uri: string; name: string }>): void {
    const previous = this.list
    const next = wire.map((folder, index) => {
      const uri = Uri.parse(folder.uri)
      // Keep the same object for a folder that stays, as VS Code does.
      const kept = previous.find((old) => old.uri.toString() === uri.toString())
      return kept && kept.index === index && kept.name === folder.name
        ? kept
        : { uri, name: folder.name, index }
    })
    const key = (folder: WorkspaceFolder) => folder.uri.toString()
    const nextKeys = new Set(next.map(key))
    const previousKeys = new Set(previous.map(key))
    const added = next.filter((folder) => !previousKeys.has(key(folder)))
    const removed = previous.filter((folder) => !nextKeys.has(key(folder)))
    this.list = next
    if (added.length > 0 || removed.length > 0) this.onDidChange.fire({ added, removed })
  }

  /** `undefined` when no folder is open, as in VS Code. */
  get folders(): readonly WorkspaceFolder[] | undefined {
    return this.list.length > 0 ? this.list : undefined
  }

  /** The folder containing `uri` (the innermost, for nested folders). */
  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    let best: WorkspaceFolder | undefined
    for (const folder of this.list) {
      if (contains(folder.uri, uri) && (!best || folder.uri.path.length > best.uri.path.length)) {
        best = folder
      }
    }
    return best
  }

  /**
   * `workspace.asRelativePath`: the path inside its folder, prefixed with
   * the folder's name when several folders are open (or when asked);
   * anything outside every folder comes back as it was given.
   */
  asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
    const uri = typeof pathOrUri === "string" ? Uri.file(pathOrUri) : pathOrUri
    const folder = this.getWorkspaceFolder(uri)
    if (!folder) return typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath
    const base = folder.uri.path.replace(/\/+$/, "")
    const relative = uri.path.slice(base.length).replace(/^\/+/, "")
    const prefix = includeWorkspaceFolder ?? this.list.length > 1
    return prefix && relative
      ? `${folder.name}/${relative}`
      : relative || (prefix ? folder.name : "")
  }

  addWatcher(handle: string, sink: WatcherSink): () => void {
    this.watchers.set(handle, sink)
    return () => {
      this.watchers.delete(handle)
    }
  }
}
