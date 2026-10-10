/**
 * Answer the host's FileSpace asset reads (ADR-0222 §7.2).
 *
 * A live file share serves `/uploads` and `/artifacts` from this app's Dexie:
 * when a WebDAV or SFTP client reads one, the host (already past its gateway:
 * grant, policy, path, sensitive floor) emits
 * `companion://filespace-asset-request` for one bounded slice, and this
 * module answers on the session-media channel with raw bytes. The desktop
 * WebView and the headless brain both install it through
 * `installDesktopMessageSource`, which owns that channel.
 *
 * Every read is still scoped to the conversation it names: an upload is
 * looked up through `getSessionAsset(sessionId, …)`, and an artifact must
 * belong to that session, so a request can never read another
 * conversation's row even holding its id.
 */

import type { RuntimeBridge } from "@/lib/headless/types"
import { getDb } from "@/lib/db/schema"
import { getSessionAsset } from "@/lib/db/session-assets"

/** The event the host emits; mirrors `FILESPACE_ASSET_EVENT` in Rust. */
export const FILESPACE_ASSET_EVENT = "companion://filespace-asset-request"

/** Largest slice one request may ask for; mirrors `MAX_FILESPACE_ASSET_SLICE`. */
export const MAX_FILESPACE_ASSET_SLICE = 4 * 1024 * 1024

export interface FileSpaceAssetRequest {
  requestId: string
  kind: "filespace_asset"
  sessionId: string
  mountId: string
  sourceId: string
  offset: number
  length: number
}

/** Why a slice was refused, as the host's media channel spells it. */
export type FileSpaceAssetError = "INVALID_PARAMS" | "MEDIA_NOT_FOUND"

export interface FileSpaceAssetSources {
  /** An upload's bytes, or null when it is gone or its source was not kept. */
  readUpload: (sessionId: string, assetId: string) => Promise<Blob | null>
  /** An artifact's source text, or null when it is not this session's. */
  readArtifact: (sessionId: string, artifactId: string) => Promise<string | null>
}

export const defaultFileSpaceAssetSources: FileSpaceAssetSources = {
  readUpload: async (sessionId, assetId) =>
    (await getSessionAsset(sessionId, assetId))?.blob ?? null,
  readArtifact: async (sessionId, artifactId) => {
    const row = (await getDb().artifacts.get(artifactId)) as
      { sessionId?: string; content?: string } | undefined
    if (!row || row.sessionId !== sessionId) return null
    return row.content ?? ""
  },
}

function validRequest(request: FileSpaceAssetRequest): boolean {
  return (
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.sessionId === "string" &&
    request.sessionId.length > 0 &&
    typeof request.sourceId === "string" &&
    request.sourceId.length > 0 &&
    (request.mountId === "uploads" || request.mountId === "artifacts") &&
    Number.isSafeInteger(request.offset) &&
    request.offset >= 0 &&
    Number.isSafeInteger(request.length) &&
    request.length >= 0
  )
}

async function blobSlice(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  const part = blob.slice(start, end)
  if (typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer())
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the upload"))
    reader.readAsArrayBuffer(part)
  })
}

const utf8 = new TextEncoder()

/**
 * Read the slice one request names: `[offset, offset + length)`, capped at
 * {@link MAX_FILESPACE_ASSET_SLICE} and at the end of the file. A short (or
 * empty) slice means the end.
 */
export async function readFileSpaceAssetSlice(
  request: FileSpaceAssetRequest,
  sources: FileSpaceAssetSources = defaultFileSpaceAssetSources
): Promise<{ bytes: Uint8Array; mediaType: string } | { error: FileSpaceAssetError }> {
  if (!validRequest(request)) return { error: "INVALID_PARAMS" }
  const length = Math.min(request.length, MAX_FILESPACE_ASSET_SLICE)
  if (request.mountId === "uploads") {
    const blob = await sources.readUpload(request.sessionId, request.sourceId)
    if (!blob) return { error: "MEDIA_NOT_FOUND" }
    const start = Math.min(request.offset, blob.size)
    const end = Math.min(start + length, blob.size)
    return {
      bytes: await blobSlice(blob, start, end),
      mediaType: blob.type || "application/octet-stream",
    }
  }
  const content = await sources.readArtifact(request.sessionId, request.sourceId)
  if (content === null) return { error: "MEDIA_NOT_FOUND" }
  const encoded = utf8.encode(content)
  const start = Math.min(request.offset, encoded.byteLength)
  const end = Math.min(start + length, encoded.byteLength)
  return { bytes: encoded.slice(start, end), mediaType: "application/octet-stream" }
}

/** Answer one request on the bridge. Never throws: a failure is an answer. */
export async function answerFileSpaceAsset(
  request: FileSpaceAssetRequest,
  bridge: Pick<RuntimeBridge, "respondMedia">,
  sources: FileSpaceAssetSources = defaultFileSpaceAssetSources
): Promise<void> {
  let result: Awaited<ReturnType<typeof readFileSpaceAssetSlice>>
  try {
    result = await readFileSpaceAssetSlice(request, sources)
  } catch {
    result = { error: "MEDIA_NOT_FOUND" }
  }
  if (typeof request?.requestId !== "string" || !request.requestId) return
  if ("error" in result) {
    await bridge.respondMedia({
      requestId: request.requestId,
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
      error: result.error,
    })
    return
  }
  await bridge.respondMedia({
    requestId: request.requestId,
    bytes: result.bytes,
    mediaType: result.mediaType,
  })
}
