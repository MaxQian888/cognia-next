// Moving a share's files to and from the share server (ADR-0222 §6.3).
//
// Upload (owner): a file is read twice. The first pass hashes it, because the
// manifest — sealed into the envelope when the share is created, before the
// server has minted the code the chunks are bound to — carries the plaintext
// SHA-256. The second pass reads, encrypts and uploads chunk by chunk with a
// bounded number of requests in flight, hashing again so a file that changed
// between the passes is caught before the blob is committed rather than by
// the recipient. Memory stays O(chunk × concurrency) either way.
//
// Download (viewer): chunks are fetched in order with a small prefetch window,
// decrypted, hashed and collected into a `Blob`. Chunk requests present the
// read ticket from the envelope read, so a file download never spends a view.
//
// `fetchImpl` is injected, on both sides: the app passes `proxyFetch` (the
// server URL is user-configured, so a renderer `fetch` would miss the proxy
// and the shell's `connect-src`; in a plain browser it is the browser's own
// `fetch`). Nothing here imports app modules, so the standalone viewer can
// bundle it.

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

import {
  SHARE_BLOB_CHUNK_BYTES,
  SHARE_BLOB_CHUNK_OVERHEAD_BYTES,
  decryptShareBlobChunk,
  deriveShareBlobKey,
  encryptShareBlobChunk,
  newShareBlobId,
  newShareBlobIvPrefix,
  shareBlobChunkCount,
  shareBlobChunkLength,
  shareBlobStoredBytes,
} from "./blob-crypto"
import type { ShareFileEntry } from "./types"

/** Bytes of one file, read a slice at a time. */
export interface ShareBlobSource {
  /** Plaintext size when the source was opened. */
  size: number
  /**
   * Exactly `length` bytes from `offset`, or a rejection. A source whose
   * bytes or size moved under it rejects with {@link ShareFileChangedError}.
   */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
}

/** Progress of one file: plaintext bytes processed out of `total`. */
export type ShareBlobProgress = (done: number, total: number) => void

/** The file changed while it was being shared; nothing half-written is committed. */
export class ShareFileChangedError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while it was being shared`)
    this.name = "ShareFileChangedError"
  }
}

/** A downloaded file does not match its manifest. */
export class ShareFileIntegrityError extends Error {
  constructor(readonly path: string) {
    super(`${path} failed its integrity check: the download was truncated or tampered with`)
    this.name = "ShareFileIntegrityError"
  }
}

/**
 * The read ticket was refused — it expired, or the share was revoked and
 * re-created. A fresh envelope read issues a new one (unless the share was
 * burn-after-read, whose files go with its ticket).
 */
export class ShareTicketExpiredError extends Error {
  constructor() {
    super("The share's download ticket expired")
    this.name = "ShareTicketExpiredError"
  }
}

/** The share, or this file of it, is gone from the server. */
export class ShareFileUnavailableError extends Error {
  constructor(readonly path: string) {
    super(`${path} is no longer available`)
    this.name = "ShareFileUnavailableError"
  }
}

/** A non-retryable or exhausted error response from the blob endpoints. */
export class ShareBlobRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "ShareBlobRequestError"
  }
}

/** Requests one upload keeps in flight. */
export const SHARE_BLOB_UPLOAD_CONCURRENCY = 3
/** Chunks one download fetches ahead of the one it is decrypting. */
export const SHARE_BLOB_DOWNLOAD_PREFETCH = 2
/** Attempts per request before a transient failure becomes an error. */
export const SHARE_BLOB_MAX_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 500

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface RetryOptions {
  signal?: AbortSignal
  /** Base backoff; doubled per attempt. Tests pass 0. */
  retryDelayMs?: number
}

function abortError(): Error {
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 504)
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body?.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

/**
 * Run `request` until it answers with a non-transient status. Network errors
 * and 408/425/429/5xx are retried with exponential backoff; an abort is not.
 */
async function withRetry(
  request: () => Promise<Response>,
  options: RetryOptions
): Promise<Response> {
  const base = options.retryDelayMs ?? RETRY_BASE_DELAY_MS
  let lastError: unknown
  for (let attempt = 0; attempt < SHARE_BLOB_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(options.signal)
    if (attempt > 0) await sleep(base * 2 ** (attempt - 1), options.signal)
    let res: Response
    try {
      res = await request()
    } catch (error) {
      if (options.signal?.aborted || (error as Error)?.name === "AbortError") throw error
      lastError = error
      continue
    }
    if (!isTransientStatus(res.status)) return res
    lastError = new ShareBlobRequestError(res.status, await errorText(res))
  }
  throw lastError
}

function blobUrl(baseUrl: string, code: string, blobId: string, tail: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/share/${encodeURIComponent(code)}/blobs/${blobId}/${tail}`
}

function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Hex SHA-256 of a whole source, read a chunk at a time. */
export async function hashShareBlobSource(
  source: ShareBlobSource,
  options: { path: string; signal?: AbortSignal; onProgress?: ShareBlobProgress } = { path: "" }
): Promise<string> {
  const hasher = sha256.create()
  const count = shareBlobChunkCount(source.size)
  for (let index = 0; index < count; index++) {
    throwIfAborted(options.signal)
    const offset = index * SHARE_BLOB_CHUNK_BYTES
    const length = shareBlobChunkLength(source.size, index)
    const bytes = await source.read(offset, length, options.signal)
    if (bytes.length !== length) throw new ShareFileChangedError(options.path)
    hasher.update(bytes)
    options.onProgress?.(offset + length, source.size)
  }
  return bytesToHex(hasher.digest())
}

/** What a manifest row needs beyond the bytes. */
export interface ShareFileDescriptor {
  /** FileSpace path at share time. */
  path: string
  name: string
  mime: string
}

/** Hash a source and mint its manifest row (fresh blob id and IV prefix). */
export async function prepareShareFileEntry(
  descriptor: ShareFileDescriptor,
  source: ShareBlobSource,
  options: { signal?: AbortSignal; onProgress?: ShareBlobProgress } = {}
): Promise<ShareFileEntry> {
  const digest = await hashShareBlobSource(source, { path: descriptor.path, ...options })
  return {
    blobId: newShareBlobId(),
    path: descriptor.path,
    name: descriptor.name,
    mime: descriptor.mime || "application/octet-stream",
    size: source.size,
    sha256: digest,
    chunkSize: SHARE_BLOB_CHUNK_BYTES,
    chunkCount: shareBlobChunkCount(source.size),
    ivPrefix: newShareBlobIvPrefix(),
  }
}

export interface UploadShareBlobInput extends RetryOptions {
  baseUrl: string
  code: string
  ownerToken: string
  /** The share's key material (`ShareKeyMaterial.bytes`). */
  material: Uint8Array
  entry: ShareFileEntry
  source: ShareBlobSource
  fetchImpl: FetchLike
  onProgress?: ShareBlobProgress
  concurrency?: number
}

/**
 * Encrypt and upload one file, then commit it. Re-hashes as it reads and
 * refuses to commit when the bytes no longer match the manifest. An empty
 * file has no blob and uploads nothing.
 */
export async function uploadShareBlob(input: UploadShareBlobInput): Promise<void> {
  const { entry, source } = input
  if (source.size !== entry.size) throw new ShareFileChangedError(entry.path)
  if (entry.chunkCount === 0) {
    input.onProgress?.(0, 0)
    return
  }
  const key = await deriveShareBlobKey(input.material, entry.blobId)
  const hasher = sha256.create()
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  input.signal?.addEventListener("abort", onOuterAbort, { once: true })
  const signal = controller.signal
  const concurrency = Math.max(1, input.concurrency ?? SHARE_BLOB_UPLOAD_CONCURRENCY)
  const inflight = new Set<Promise<void>>()
  let failure: unknown
  let done = 0

  const put = async (index: number, ciphertext: Uint8Array, plainLength: number) => {
    const res = await withRetry(
      () =>
        input.fetchImpl(blobUrl(input.baseUrl, input.code, entry.blobId, String(index)), {
          method: "PUT",
          headers: {
            "X-Owner-Token": input.ownerToken,
            "Content-Type": "application/octet-stream",
          },
          body: toBody(ciphertext),
          signal,
        }),
      { signal, retryDelayMs: input.retryDelayMs }
    )
    if (res.status === 404) throw new ShareFileUnavailableError(entry.path)
    if (!res.ok) throw new ShareBlobRequestError(res.status, await errorText(res))
    done += plainLength
    input.onProgress?.(done, entry.size)
  }

  try {
    for (let index = 0; index < entry.chunkCount; index++) {
      if (failure) break
      throwIfAborted(signal)
      const offset = index * SHARE_BLOB_CHUNK_BYTES
      const length = shareBlobChunkLength(entry.size, index)
      const plaintext = await source.read(offset, length, signal)
      if (plaintext.length !== length) throw new ShareFileChangedError(entry.path)
      hasher.update(plaintext)
      const ciphertext = await encryptShareBlobChunk(
        key,
        {
          code: input.code,
          blobId: entry.blobId,
          ivPrefix: entry.ivPrefix,
          index,
          chunkCount: entry.chunkCount,
        },
        plaintext
      )
      const task: Promise<void> = put(index, ciphertext, length).then(
        () => {
          inflight.delete(task)
        },
        (error: unknown) => {
          inflight.delete(task)
          failure ??= error
          controller.abort()
        }
      )
      inflight.add(task)
      if (inflight.size >= concurrency) await Promise.race(inflight)
    }
    await Promise.all(inflight)
    if (failure) throw failure
    if (bytesToHex(hasher.digest()) !== entry.sha256) throw new ShareFileChangedError(entry.path)

    const res = await withRetry(
      () =>
        input.fetchImpl(blobUrl(input.baseUrl, input.code, entry.blobId, "commit"), {
          method: "POST",
          headers: { "X-Owner-Token": input.ownerToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            chunkCount: entry.chunkCount,
            totalBytes: shareBlobStoredBytes(entry.size),
          }),
          signal,
        }),
      { signal, retryDelayMs: input.retryDelayMs }
    )
    if (res.status === 404) throw new ShareFileUnavailableError(entry.path)
    if (!res.ok) throw new ShareBlobRequestError(res.status, await errorText(res))
  } catch (error) {
    controller.abort()
    await Promise.allSettled(inflight)
    if (input.signal?.aborted) throw abortError()
    throw failure ?? error
  } finally {
    input.signal?.removeEventListener("abort", onOuterAbort)
  }
}

export interface DownloadShareBlobInput extends RetryOptions {
  baseUrl: string
  code: string
  readTicket: string
  material: Uint8Array
  entry: ShareFileEntry
  /** The caller's managed fetch (`proxyFetch` in the app), like the upload side. */
  fetchImpl: FetchLike
  onProgress?: ShareBlobProgress
}

/** Download, decrypt and verify one file. */
export async function downloadShareBlob(input: DownloadShareBlobInput): Promise<Blob> {
  const { entry, fetchImpl } = input
  const type = entry.mime || "application/octet-stream"
  if (entry.chunkCount !== shareBlobChunkCount(entry.size)) {
    throw new ShareFileIntegrityError(entry.path)
  }
  const hasher = sha256.create()
  if (entry.chunkCount === 0) {
    if (bytesToHex(hasher.digest()) !== entry.sha256) throw new ShareFileIntegrityError(entry.path)
    return new Blob([], { type })
  }
  const key = await deriveShareBlobKey(input.material, entry.blobId)
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  input.signal?.addEventListener("abort", onOuterAbort, { once: true })
  const signal = controller.signal

  const fetchChunk = async (index: number): Promise<Uint8Array> => {
    const res = await withRetry(
      () =>
        fetchImpl(blobUrl(input.baseUrl, input.code, entry.blobId, String(index)), {
          method: "GET",
          headers: { "X-Read-Ticket": input.readTicket },
          cache: "no-store",
          signal,
        }),
      { signal, retryDelayMs: input.retryDelayMs }
    )
    if (res.status === 401) throw new ShareTicketExpiredError()
    if (res.status === 404) throw new ShareFileUnavailableError(entry.path)
    if (!res.ok) throw new ShareBlobRequestError(res.status, await errorText(res))
    const bytes = new Uint8Array(await res.arrayBuffer())
    const expected = shareBlobChunkLength(entry.size, index) + SHARE_BLOB_CHUNK_OVERHEAD_BYTES
    if (bytes.length !== expected) throw new ShareFileIntegrityError(entry.path)
    return bytes
  }

  const pending = new Map<number, Promise<Uint8Array>>()
  const schedule = (index: number) => {
    if (index >= entry.chunkCount || pending.has(index)) return
    const request = fetchChunk(index)
    // Rejections surface when the chunk is awaited in order; until then a
    // prefetched failure must not become an unhandled rejection.
    request.catch(() => undefined)
    pending.set(index, request)
  }

  const parts: BlobPart[] = []
  let done = 0
  try {
    for (let index = 0; index < entry.chunkCount; index++) {
      for (let ahead = 0; ahead <= SHARE_BLOB_DOWNLOAD_PREFETCH; ahead++) schedule(index + ahead)
      const ciphertext = await pending.get(index)!
      pending.delete(index)
      let plaintext: Uint8Array
      try {
        plaintext = await decryptShareBlobChunk(
          key,
          {
            code: input.code,
            blobId: entry.blobId,
            ivPrefix: entry.ivPrefix,
            index,
            chunkCount: entry.chunkCount,
          },
          ciphertext
        )
      } catch {
        throw new ShareFileIntegrityError(entry.path)
      }
      hasher.update(plaintext)
      parts.push(toBody(plaintext))
      done += plaintext.length
      input.onProgress?.(done, entry.size)
    }
  } catch (error) {
    controller.abort()
    if (input.signal?.aborted) throw abortError()
    throw error
  } finally {
    input.signal?.removeEventListener("abort", onOuterAbort)
  }
  if (bytesToHex(hasher.digest()) !== entry.sha256) throw new ShareFileIntegrityError(entry.path)
  return new Blob(parts, { type })
}
