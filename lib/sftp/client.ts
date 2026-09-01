/**
 * File transfer over an SSH profile the desktop has synchronized (ADR-0162).
 *
 * Every call goes through `transport.call`, so the same module works on the
 * desktop (a Tauri `invoke` reaching the `#[tauri::command]` wrappers in
 * `src-tauri/src/sftp_service.rs`) and from a paired phone or browser (the
 * companion `_rpc` face reaching the arms in `rpc/sftp.rs`). Both doors lead to
 * one implementation, and the argument names are the same on both, which is why
 * nothing here asks which shell it is running in.
 *
 * # What a caller is actually asking for
 *
 * A `profileId` and an absolute path on the remote machine. Not a root and a
 * relative path: there is no root. `authorize_workspace_root` confines the
 * workspace file API to a registered directory, and SFTP has no equivalent,
 * because the paths are somebody else's machine's absolute paths and that
 * machine resolves its own symlinks. The tree adapter below joins a base and a
 * relative path for `ProjectFileTree`'s benefit, and that base is a starting
 * point for browsing, never a boundary. Nothing here should be read as one.
 *
 * # Approval
 *
 * Opening a transfer is `approval: "interactive"` in the command manifest, so a
 * paired device must present a device-bound lease. The desktop presents none,
 * because it is the host and there is nobody else to ask. See
 * {@link requestSftpTransferApproval}.
 */

import { isTauri, transport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import type { WorkspaceEntry } from "@/lib/files/types"
import type { ProjectFileTreeDeps } from "@/components/editor/project/project-file-tree"

/** Mirrors Rust `SftpEntry`. */
export interface SftpEntry {
  name: string
  /** Absolute path on the remote machine. */
  path: string
  kind: "dir" | "file" | "symlink" | "other"
  size: number
  /** SFTP mtime in unix SECONDS, or null when the server reported none. */
  modified: number | null
  /** The raw mode word, not a rendered string. */
  permissions: number | null
}

/** The two commands that carry an interactive approval. */
export const SFTP_TRANSFER_OPERATIONS = ["sftp_download_open", "sftp_upload_open"] as const

/**
 * Obtain the approval a paired device needs before it may start a transfer.
 *
 * Returns `null` on the desktop, which is the correct answer rather than a
 * degraded one: the manifest's interactive approval exists so a *remote* device
 * asks a human at the host, and on the desktop the caller already is that human.
 *
 * Call this from an explicit user action only. It asks the host to prompt
 * somebody, and a background refresh that triggers a prompt is how a permission
 * dialog stops meaning anything.
 */
export async function requestSftpTransferApproval(): Promise<string | null> {
  if (isTauri()) return null
  const lease = await issueHostAdminLease([...SFTP_TRANSFER_OPERATIONS])
  return lease.token
}

function withLease(
  args: Record<string, unknown>,
  adminLease: string | null | undefined
): Record<string, unknown> {
  return adminLease ? { ...args, adminLease } : args
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

export async function listSftpDir(profileId: string, path: string): Promise<SftpEntry[]> {
  const result = await transport.call<{ entries: SftpEntry[] }>("sftp_list_dir", {
    profileId,
    path,
  })
  return result.entries
}

export async function statSftpEntry(profileId: string, path: string): Promise<SftpEntry> {
  const result = await transport.call<{ entry: SftpEntry }>("sftp_stat", { profileId, path })
  return result.entry
}

/**
 * Ask the machine where a path actually lands, symlinks included.
 *
 * The one call that turns a relative or `~`-shaped guess into somewhere real,
 * which is how a browser opens on the profile user's home without this side
 * inventing a path for it.
 */
export async function resolveSftpPath(profileId: string, path: string): Promise<string> {
  const result = await transport.call<{ path: string }>("sftp_realpath", { profileId, path })
  return result.path
}

export async function createSftpDir(profileId: string, path: string): Promise<void> {
  await transport.call("sftp_create_dir", { profileId, path })
}

export async function renameSftpEntry(profileId: string, from: string, to: string): Promise<void> {
  await transport.call("sftp_rename_entry", { profileId, from, to })
}

export async function deleteSftpEntry(
  profileId: string,
  path: string,
  isDir: boolean
): Promise<void> {
  await transport.call("sftp_delete_entry", { profileId, path, isDir })
}

/**
 * Drop the host's pooled connections for a profile.
 *
 * Idle ones are reaped on their own, so this is for the case where the user is
 * done and would rather the connection to their production box not sit open.
 * Answers with how many were closed, and zero is an ordinary answer.
 */
export async function closeSftpSession(profileId: string): Promise<number> {
  const result = await transport.call<{ closed: number }>("sftp_session_close", { profileId })
  return result.closed
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Join a browsing base and a path relative to it.
 *
 * Exported because the tree adapter, the queue and the interface all have to
 * agree on it, and because a remote path is not a local one: the separator is
 * always `/`, whatever this client is running on.
 */
export function joinRemotePath(base: string, relPath?: string): string {
  const rel = (relPath ?? "").replace(/^\/+/, "")
  if (!rel) return base || "/"
  if (!base || base === "/") return `/${rel}`
  return `${base.replace(/\/+$/, "")}/${rel}`
}

/** The path of `absolute` relative to `base`, or `absolute` when it is outside. */
export function relativeRemotePath(base: string, absolute: string): string {
  const prefix = base === "/" ? "/" : `${base.replace(/\/+$/, "")}/`
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute
}

// ---------------------------------------------------------------------------
// The file-tree adapter
// ---------------------------------------------------------------------------

/**
 * Convert one remote entry into what `ProjectFileTree` renders.
 *
 * A symlink is reported as whatever the server said it was, and it is NOT
 * resolved here. `sftp_realpath` is the call that resolves one, and doing it
 * silently per row would turn a listing into one round trip per link.
 * `mtimeMs` is milliseconds because that is the tree's vocabulary, and SFTP
 * reports seconds.
 */
export function toWorkspaceEntry(base: string, entry: SftpEntry): WorkspaceEntry {
  return {
    relPath: relativeRemotePath(base, entry.path),
    absolutePath: entry.path,
    isDir: entry.kind === "dir",
    size: entry.size,
    mtimeMs: entry.modified === null ? null : entry.modified * 1000,
  }
}

/**
 * A `ProjectFileTree` wired to a remote machine.
 *
 * The tree was written with injected dependencies for exactly this, and it was
 * taught to report failures for exactly this too: over a local workspace a
 * denied listing is rare enough that the old swallowed catch survived for
 * years, and over SFTP permission denials, read-only mounts and dropped
 * connections are ordinary.
 *
 * `writeFile` creates an empty file by uploading zero bytes. The tree only ever
 * calls it to create one, so this never needs the chunk loop.
 */
export function createSftpFileTreeDeps(profileId: string): ProjectFileTreeDeps {
  return {
    listDir: async (root, relPath) =>
      (await listSftpDir(profileId, joinRemotePath(root, relPath))).map((entry) =>
        toWorkspaceEntry(root, entry)
      ),
    createDir: async (root, relPath) => {
      await createSftpDir(profileId, joinRemotePath(root, relPath))
    },
    writeFile: async (root, relPath, contents) => {
      await uploadSftpFile(profileId, joinRemotePath(root, relPath), new Blob([contents]))
    },
    deleteEntry: async (root, relPath, isDir) => {
      await deleteSftpEntry(profileId, joinRemotePath(root, relPath), isDir === true)
    },
    renameEntry: async (root, from, to) => {
      await renameSftpEntry(profileId, joinRemotePath(root, from), joinRemotePath(root, to))
    },
  }
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface SftpTransferProgress {
  transferred: number
  total: number
}

export interface SftpTransferOptions {
  /** The approval from {@link requestSftpTransferApproval}. Null on the desktop. */
  adminLease?: string | null
  onProgress?: (progress: SftpTransferProgress) => void
  /** Checked between chunks. Aborting stops the transfer at the next boundary. */
  signal?: AbortSignal
  /**
   * Bytes already held by the caller, for a download that is being resumed.
   * The host reads from an explicit offset, so resuming costs nothing beyond
   * remembering what was already received.
   */
  resumeFrom?: Uint8Array
}

interface DownloadHandle {
  transferId: string
  size: number
  chunkBytes: number
}

interface UploadHandle {
  transferId: string
  chunkBytes: number
  writeHead: number
}

export class SftpTransferAbortedError extends Error {
  constructor() {
    super("the transfer was cancelled")
    this.name = "SftpTransferAbortedError"
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  // Chunked so a multi-megabyte buffer does not blow the argument limit of
  // `String.fromCharCode`, which a naive spread hits at around 100k elements.
  const stride = 0x8000
  for (let index = 0; index < bytes.length; index += stride) {
    binary += String.fromCharCode(...bytes.subarray(index, index + stride))
  }
  return btoa(binary)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SftpTransferAbortedError()
}

/**
 * Read a whole remote file.
 *
 * The chunk size comes from the host's answer to `_open`, never from a constant
 * here. It is bounded by the terminal frame ceiling on the hop between the app
 * process and its terminal host, which is not a number this side can know, and
 * a client that guessed high would have every chunk refused.
 */
export async function downloadSftpFile(
  profileId: string,
  path: string,
  options: SftpTransferOptions = {}
): Promise<Blob> {
  throwIfAborted(options.signal)
  const handle = await transport.call<DownloadHandle>(
    "sftp_download_open",
    withLease({ profileId, path }, options.adminLease)
  )
  const chunks: Uint8Array[] = []
  let offset = 0
  if (options.resumeFrom?.length) {
    chunks.push(options.resumeFrom)
    offset = options.resumeFrom.length
  }
  try {
    options.onProgress?.({ transferred: offset, total: handle.size })
    // Stops on the server's own end rather than on `offset < size`. The file
    // can be appended to or truncated while it is being read, and the server is
    // the only authority on where it stops.
    for (;;) {
      throwIfAborted(options.signal)
      const chunk = await transport.call<{ data: string; eof: boolean }>(
        "sftp_download_read_chunk",
        { transferId: handle.transferId, offset }
      )
      const bytes = decodeBase64(chunk.data)
      if (bytes.length > 0) {
        chunks.push(bytes)
        offset += bytes.length
        options.onProgress?.({ transferred: offset, total: Math.max(handle.size, offset) })
      }
      if (chunk.eof || bytes.length === 0) break
    }
    return new Blob(chunks as BlobPart[])
  } finally {
    await transport
      .call("sftp_download_close", { transferId: handle.transferId })
      .catch(() => undefined)
  }
}

export interface SftpUploadResult {
  path: string
  size: number
  declaredSize: number
  /** False when the machine holds fewer bytes than the caller declared. */
  complete: boolean
}

/**
 * Write a whole file to the remote machine.
 *
 * Resumes from the host's write head rather than from zero, and the host reads
 * that from the machine itself at `_open`. A client that resumed from its own
 * arithmetic could write past a hole and leave a file of the right length and
 * the wrong contents.
 *
 * An abort deliberately leaves the partial file in place. Removing it would be
 * a delete nobody asked for, and those bytes are what a later resume starts
 * from.
 */
export async function uploadSftpFile(
  profileId: string,
  path: string,
  body: Blob,
  options: SftpTransferOptions = {}
): Promise<SftpUploadResult> {
  throwIfAborted(options.signal)
  const bytes = new Uint8Array(await body.arrayBuffer())
  const handle = await transport.call<UploadHandle>(
    "sftp_upload_open",
    withLease({ profileId, path, size: bytes.byteLength }, options.adminLease)
  )
  let sent = Math.min(handle.writeHead, bytes.byteLength)
  options.onProgress?.({ transferred: sent, total: bytes.byteLength })
  try {
    while (sent < bytes.byteLength) {
      throwIfAborted(options.signal)
      const slice = bytes.subarray(sent, sent + handle.chunkBytes)
      const result = await transport.call<{ writeHead: number }>("sftp_upload_write_chunk", {
        transferId: handle.transferId,
        data: encodeBase64(slice),
      })
      // The host's answer, not local arithmetic. They agree unless something
      // else on that machine also wrote the file, and in that case the host is
      // the one holding the truth.
      if (result.writeHead <= sent) {
        throw new Error("the host did not advance its write head")
      }
      sent = result.writeHead
      options.onProgress?.({ transferred: sent, total: bytes.byteLength })
    }
    return await transport.call<SftpUploadResult>("sftp_upload_commit", {
      transferId: handle.transferId,
    })
  } catch (error) {
    await transport
      .call("sftp_upload_abort", { transferId: handle.transferId })
      .catch(() => undefined)
    throw error
  }
}
