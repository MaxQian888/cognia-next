/**
 * `vscode.workspace.fs` for `file:` URIs.
 *
 * The host does the file work itself, with Node's `fs`, so binary contents,
 * `stat` times and permissions, copies and renames behave as in VS Code.
 * What it may touch is decided elsewhere:
 *
 *   - the extension's own directories need no one's say: its install
 *     directory is readable, its storage and log directories readable and
 *     writable, as in VS Code;
 *   - anything else is asked of the renderer (`fs:authorize`), which checks
 *     the extension holds `filesystem:read` / `filesystem:write` and the path
 *     is inside an open workspace folder, and answers with that folder.
 *
 * Paths are resolved through symlinks before either check, and the resolved
 * path must stay inside the resolved folder, so a link cannot lead out.
 *
 * Not supported: other schemes (there are no file system providers) and
 * `delete` with `useTrash` (there is no trash to move to); both throw
 * `FileSystemError.Unavailable`.
 */

import { constants as fsConstants, promises as fs } from "node:fs"
import * as nodePath from "node:path"

import type { RpcConnection } from "../rpc"
import { FilePermission, FileSystemError } from "./api-types"
import { FileType, Uri } from "./types"

export interface OwnedPaths {
  /** Readable only (the extension's install directory). */
  readOnly: string[]
  /** Readable and writable (its storage and log directories). */
  readWrite: string[]
}

export interface FileStat {
  type: number
  ctime: number
  mtime: number
  size: number
  permissions?: number
}

type Access = "read" | "write"

function within(path: string, base: string): boolean {
  const relative = nodePath.relative(base, path)
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative))
}

/** `path` through every symlink; a path that does not exist yet resolves through its deepest existing ancestor. */
async function realPath(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const real = await fs.realpath(current)
      return missing.length > 0 ? nodePath.join(real, ...missing.reverse()) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const parent = nodePath.dirname(current)
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error
      missing.push(nodePath.basename(current))
      current = parent
    }
  }
}

/** A Node error as the `FileSystemError` VS Code would throw. */
function toFileSystemError(error: unknown, uri: Uri): unknown {
  if (error instanceof FileSystemError) return error
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "ENOENT":
      return FileSystemError.FileNotFound(uri)
    case "EEXIST":
    case "ENOTEMPTY":
      return FileSystemError.FileExists(uri)
    case "ENOTDIR":
      return FileSystemError.FileNotADirectory(uri)
    case "EISDIR":
      return FileSystemError.FileIsADirectory(uri)
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return FileSystemError.NoPermissions(uri)
    default:
      return error
  }
}

async function typeOf(path: string): Promise<number> {
  const link = await fs.lstat(path)
  if (!link.isSymbolicLink()) {
    return link.isDirectory()
      ? FileType.Directory
      : link.isFile()
        ? FileType.File
        : FileType.Unknown
  }
  try {
    const target = await fs.stat(path)
    return (
      (target.isDirectory() ? FileType.Directory : target.isFile() ? FileType.File : 0) |
      FileType.SymbolicLink
    )
  } catch {
    // A dangling link is still a link.
    return FileType.SymbolicLink
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

export function createWorkspaceFileSystem(deps: {
  connection: RpcConnection
  extensionId: string
  ownedPaths: () => OwnedPaths
}) {
  const { connection, extensionId } = deps

  function pathOf(value: Uri): string {
    const uri = Uri.revive(value)
    if (!uri) throw FileSystemError.FileNotFound(String(value))
    if (uri.scheme !== "file") {
      throw FileSystemError.Unavailable(
        `No file system provider for "${uri.scheme}" (${uri.toString()})`
      )
    }
    return nodePath.resolve(uri.fsPath)
  }

  /** May the extension `access` `path`? Answers with the resolved path to use. */
  async function authorize(uri: Uri, access: Access): Promise<string> {
    const requested = pathOf(uri)
    const real = await realPath(requested)
    const owned = deps.ownedPaths()
    const ownedRoots = access === "read" ? [...owned.readOnly, ...owned.readWrite] : owned.readWrite
    for (const root of ownedRoots) {
      if (within(real, await realPath(nodePath.resolve(root)))) return real
    }
    let folder: string
    try {
      const answer = await connection.sendRequest<{ root: string }>("fs:authorize", {
        extensionId,
        path: requested,
        access,
      })
      folder = answer.root
    } catch (error) {
      // The connection rejects with the renderer's `{ code, message }`.
      const reason =
        error && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : `No ${access} access to ${uri.toString()}`
      throw FileSystemError.NoPermissions(reason)
    }
    if (!within(real, await realPath(folder))) {
      throw FileSystemError.NoPermissions(`${uri.toString()} leads outside the workspace folder`)
    }
    return real
  }

  async function run<T>(uri: Uri, task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    } catch (error) {
      throw toFileSystemError(error, uri)
    }
  }

  return {
    async stat(uri: Uri): Promise<FileStat> {
      return run(uri, async () => {
        const path = await authorize(uri, "read")
        const info = await fs.stat(path).catch(async (error) => {
          // A dangling link: describe the link itself.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return fs.lstat(path)
          throw error
        })
        let writable = true
        try {
          await fs.access(path, fsConstants.W_OK)
        } catch {
          writable = false
        }
        return {
          type: await typeOf(path),
          ctime: info.birthtimeMs || info.ctimeMs,
          mtime: info.mtimeMs,
          size: info.size,
          ...(writable ? {} : { permissions: FilePermission.Readonly }),
        }
      })
    },

    async readDirectory(uri: Uri): Promise<Array<[string, number]>> {
      return run(uri, async () => {
        const path = await authorize(uri, "read")
        const entries = await fs.readdir(path)
        return Promise.all(
          entries.map(async (name): Promise<[string, number]> => [
            name,
            await typeOf(nodePath.join(path, name)).catch(() => FileType.Unknown),
          ])
        )
      })
    },

    /** Creates missing parent directories too, as VS Code does. */
    async createDirectory(uri: Uri): Promise<void> {
      return run(uri, async () => {
        const path = await authorize(uri, "write")
        await fs.mkdir(path, { recursive: true })
      })
    },

    async readFile(uri: Uri): Promise<Uint8Array> {
      return run(uri, async () => {
        const path = await authorize(uri, "read")
        const buffer = await fs.readFile(path)
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      })
    },

    /** Replaces the file's contents, creating it and its parent directories. */
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      return run(uri, async () => {
        const path = await authorize(uri, "write")
        await fs.mkdir(nodePath.dirname(path), { recursive: true })
        await fs.writeFile(path, content)
      })
    },

    async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
      return run(uri, async () => {
        if (options?.useTrash) {
          throw FileSystemError.Unavailable(
            `Moving ${uri.toString()} to the trash is not supported; delete it without useTrash`
          )
        }
        const path = await authorize(uri, "write")
        const info = await fs.lstat(path)
        if (info.isDirectory()) {
          await fs.rm(path, { recursive: options?.recursive === true })
        } else {
          await fs.unlink(path)
        }
      })
    },

    async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
      return run(source, async () => {
        const from = await authorize(source, "write")
        const to = await authorize(target, "write")
        if (from === to) return
        if (await exists(to)) {
          if (!options?.overwrite) throw FileSystemError.FileExists(target)
          await fs.rm(to, { recursive: true, force: true })
        }
        await fs.mkdir(nodePath.dirname(to), { recursive: true })
        try {
          await fs.rename(from, to)
        } catch (error) {
          // Across devices a rename is a copy and a delete.
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
          await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
          await fs.rm(from, { recursive: true, force: true })
        }
      })
    },

    async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
      return run(source, async () => {
        const from = await authorize(source, "read")
        const to = await authorize(target, "write")
        if (from === to) return
        if (await exists(to)) {
          if (!options?.overwrite) throw FileSystemError.FileExists(target)
          await fs.rm(to, { recursive: true, force: true })
        }
        await fs.mkdir(nodePath.dirname(to), { recursive: true })
        await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
      })
    },

    /** `true` for `file:`; other schemes have no provider, so their writability is unknown. */
    isWritableFileSystem(scheme: string): boolean | undefined {
      return scheme === "file" ? true : undefined
    },
  }
}
