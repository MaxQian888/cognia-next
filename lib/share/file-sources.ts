// Where a shared file's bytes come from (ADR-0222 §6.1): a `Blob` in Dexie
// (an upload), a string (an artifact body), or a file on a workspace disk
// read in slices through `fs_read_workspace_file_chunk`, which every Host
// answers. Each source reads one chunk at a time, so sharing a 500 MiB file
// never holds more than a chunk of it.

import { readWorkspaceFileChunk } from "@/lib/files/workspace-fs"

import { decodeBase64 } from "./encoding"
import { ShareFileChangedError, type ShareBlobSource } from "./blobs"

function abortError(): Error {
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

/** Bytes already in memory. */
export function bytesShareSource(bytes: Uint8Array): ShareBlobSource {
  return {
    size: bytes.length,
    async read(offset, length, signal) {
      if (signal?.aborted) throw abortError()
      return bytes.subarray(offset, offset + length)
    },
  }
}

/** A string, shared as its UTF-8 bytes. */
export function textShareSource(text: string): ShareBlobSource {
  return bytesShareSource(new TextEncoder().encode(text))
}

/** A `Blob` (an upload's stored bytes), sliced without loading it whole. */
export function blobShareSource(blob: Blob): ShareBlobSource {
  return {
    size: blob.size,
    async read(offset, length, signal) {
      if (signal?.aborted) throw abortError()
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
    },
  }
}

/**
 * A file on a workspace disk. `size` is what the selection saw; a slice that
 * reports another size, or comes back short, means the file changed under
 * the share and is refused rather than shared torn.
 */
export function workspaceShareSource(
  root: string,
  relPath: string,
  size: number,
  path: string
): ShareBlobSource {
  return {
    size,
    async read(offset, length, signal) {
      if (signal?.aborted) throw abortError()
      const chunk = await readWorkspaceFileChunk(root, relPath, offset, length)
      if (signal?.aborted) throw abortError()
      if (chunk.size !== size || chunk.bytesRead !== length) throw new ShareFileChangedError(path)
      return decodeBase64(chunk.dataBase64)
    },
  }
}
