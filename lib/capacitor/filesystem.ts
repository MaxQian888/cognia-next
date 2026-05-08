"use client"

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/filesystem` wrapper. Used by the Backup module (Wave 3) to
 * write encrypted backup files into `Documents/cognia/backups/` and to
 * import them back. Encoding defaults to base64 so binary payloads round-
 * trip safely.
 */

export type Directory = "documents" | "data" | "cache" | "external" | "library"
export type Encoding = "utf8" | "ascii" | "utf16" | "base64"

const DIRECTORY_MAP: Record<Directory, string> = {
  documents: "DOCUMENTS",
  data: "DATA",
  cache: "CACHE",
  external: "EXTERNAL_STORAGE",
  library: "LIBRARY",
}

const ENCODING_MAP: Record<Encoding, string | undefined> = {
  utf8: "utf8",
  ascii: "ascii",
  utf16: "utf16",
  // Capacitor returns base64 when no encoding is specified.
  base64: undefined,
}

interface FilesystemShape {
  writeFile(opts: {
    path: string
    data: string
    directory?: string
    encoding?: string
    recursive?: boolean
  }): Promise<{ uri: string }>
  readFile(opts: {
    path: string
    directory?: string
    encoding?: string
  }): Promise<{ data: string | Blob }>
  deleteFile(opts: { path: string; directory?: string }): Promise<void>
  mkdir(opts: { path: string; directory?: string; recursive?: boolean }): Promise<void>
  readdir(opts: { path: string; directory?: string }): Promise<{
    files: Array<{
      name: string
      type: "file" | "directory"
      size: number
      mtime: number
      uri: string
    }>
  }>
  stat(opts: { path: string; directory?: string }): Promise<{
    type: "file" | "directory"
    size: number
    mtime: number
    uri: string
  }>
}

export type FilesystemLoader = () => Promise<FilesystemShape>

const defaultLoader: FilesystemLoader = makeDefaultLoader<FilesystemShape>(
  "@capacitor/filesystem",
  "Filesystem"
)

export interface WriteFileOptions {
  path: string
  data: string
  directory?: Directory
  encoding?: Encoding
  recursive?: boolean
  loader?: FilesystemLoader
}

export interface ReadFileOptions {
  path: string
  directory?: Directory
  encoding?: Encoding
  loader?: FilesystemLoader
}

export interface DeleteFileOptions {
  path: string
  directory?: Directory
  loader?: FilesystemLoader
}

export interface MakeDirOptions {
  path: string
  directory?: Directory
  recursive?: boolean
  loader?: FilesystemLoader
}

export interface ListDirOptions {
  path: string
  directory?: Directory
  loader?: FilesystemLoader
}

export type DirEntry = {
  name: string
  type: "file" | "directory"
  size: number
  mtime: number
  uri: string
}

export async function writeFile(opts: WriteFileOptions): Promise<ValueOutcome<{ uri: string }>> {
  const {
    path,
    data,
    directory = "documents",
    encoding = "base64",
    recursive = true,
    loader = defaultLoader,
  } = opts
  return withPlugin(loader, async (fs) => {
    const result = await fs.writeFile({
      path,
      data,
      directory: DIRECTORY_MAP[directory],
      encoding: ENCODING_MAP[encoding],
      recursive,
    })
    return { kind: "ok" as const, value: { uri: result.uri } }
  })
}

export async function readFile(opts: ReadFileOptions): Promise<ValueOutcome<string>> {
  const { path, directory = "documents", encoding = "base64", loader = defaultLoader } = opts
  return withPlugin(loader, async (fs) => {
    const result = await fs.readFile({
      path,
      directory: DIRECTORY_MAP[directory],
      encoding: ENCODING_MAP[encoding],
    })
    if (typeof result.data === "string") {
      return { kind: "ok" as const, value: result.data }
    }
    // Blob fallback (rare in mobile, but possible if the plugin returns it)
    const text = await result.data.text()
    return { kind: "ok" as const, value: text }
  })
}

export async function deleteFile(opts: DeleteFileOptions) {
  const { path, directory = "documents", loader = defaultLoader } = opts
  return withPlugin(loader, async (fs) => {
    await fs.deleteFile({ path, directory: DIRECTORY_MAP[directory] })
    return { kind: "ok" as const, value: null }
  })
}

export async function mkdir(opts: MakeDirOptions) {
  const { path, directory = "documents", recursive = true, loader = defaultLoader } = opts
  return withPlugin(loader, async (fs) => {
    await fs.mkdir({ path, directory: DIRECTORY_MAP[directory], recursive })
    return { kind: "ok" as const, value: null }
  })
}

export async function listDir(opts: ListDirOptions): Promise<ValueOutcome<DirEntry[]>> {
  const { path, directory = "documents", loader = defaultLoader } = opts
  return withPlugin(loader, async (fs) => {
    const result = await fs.readdir({ path, directory: DIRECTORY_MAP[directory] })
    return { kind: "ok" as const, value: result.files }
  })
}
