// Owner-side share service: create / revoke / inspect public links.
//
// Every request goes through `proxyFetch`: the worker URL is whatever the user
// typed in Settings, so it is never on the packaged shell's `connect-src`
// allowlist, and a renderer `fetch` would also ignore the configured proxy.
//
// Create flow: generate a random key → encrypt the payload (key never uploaded)
// → POST the opaque envelope to the worker with the bearer secret → mint the
// shareable URL `${base}/share/view?c=<code>#k=<key>` → mirror it into Dexie.
// The viewer is the app's own `/share/view` route (ADR-0037 Phase 4); reads are
// public and handled there, not by this module.
//
// A share may carry files (ADR-0222). Their manifest rides inside the
// envelope; their bytes are uploaded as encrypted blobs once the server has
// minted the code. If any file fails, the share is revoked so no half-share
// stays live.

import { proxyFetch } from "@/lib/network/proxy-fetch"

import { generateShareKey, encodeShareKey } from "./keys"
import { encryptSharePayloadWithMaterial, prepareShareKeyMaterial } from "./crypto"
import { resolveShareEndpoint, type ShareEndpoint } from "./config"
import {
  prepareShareFileEntry,
  uploadShareBlob,
  type ShareBlobSource,
  type ShareFileDescriptor,
} from "./blobs"
import { checkShareSelectionLimits, type ShareSelectionLimitViolation } from "./file-selection"
import {
  recordSharedLink,
  markSharedLinkRevoked,
  getSharedLinkByCode,
  type SharedLinkRow,
} from "@/lib/db/shared-links"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type {
  CreateShareRequest,
  CreateShareResponse,
  ShareFileEntry,
  SharePayload,
  ShareStats,
} from "./types"

/** Raised when the upload bearer secret hasn't been configured yet. */
export class ShareNotConfiguredError extends Error {
  constructor() {
    super("Share service is not configured: set the worker URL and upload secret in Settings")
    this.name = "ShareNotConfiguredError"
  }
}

/** Raised for a non-2xx response from the worker. */
export class ShareRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "ShareRequestError"
  }
}

/** The share worker's default maximum JSON request size. */
export const DEFAULT_SHARE_MAX_BODY_BYTES = 10 * 1024 * 1024

/** Raised before upload when the encrypted request cannot fit on the worker. */
export class SharePayloadTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number
  ) {
    super(`Encrypted share request is ${actualBytes} bytes; maximum is ${maxBytes} bytes`)
    this.name = "SharePayloadTooLargeError"
  }
}

export function assertShareRequestSize(
  serializedBody: string,
  maxBytes = DEFAULT_SHARE_MAX_BODY_BYTES
): void {
  let actualBytes = 0
  for (const character of serializedBody) {
    const codePoint = character.codePointAt(0) ?? 0
    actualBytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  if (actualBytes > maxBytes) {
    throw new SharePayloadTooLargeError(actualBytes, maxBytes)
  }
}

/** Raised before anything is uploaded when the files exceed the server's limits. */
export class ShareFilesTooLargeError extends Error {
  constructor(readonly violations: ShareSelectionLimitViolation[]) {
    super("The selected files exceed what one share can carry")
    this.name = "ShareFilesTooLargeError"
  }
}

/**
 * Uploading a share's files failed after the share was created. `revoked`
 * says whether the half-made share was withdrawn; when it was not, the link
 * stays in My Shares so the owner can revoke it.
 */
export class ShareFilesUploadError extends Error {
  constructor(
    readonly revoked: boolean,
    readonly cause: unknown
  ) {
    super(
      revoked
        ? "Uploading the share's files failed; the link was withdrawn"
        : "Uploading the share's files failed and the link could not be withdrawn"
    )
    this.name = "ShareFilesUploadError"
  }
}

/** One file to carry: what the manifest says about it, and how to read it. */
export interface CreateShareFile extends ShareFileDescriptor {
  /** Opened twice: once to hash, once to upload. */
  open: () => Promise<ShareBlobSource>
}

/**
 * What an entry point hands the share dialog: the payload, and any files it
 * produced itself (media a transcript could not inline).
 */
export interface ShareBuild {
  payload: SharePayload
  attachments: CreateShareFile[]
  /** Media references whose bytes were gone, named in the payload without a link. */
  unavailableMedia?: number
}

/** Where a file share's creation is. Bytes are plaintext bytes. */
export interface CreateShareProgress {
  phase: "hashing" | "uploading"
  /** Index into `files`. */
  fileIndex: number
  fileCount: number
  path: string
  /** Bytes of this phase done across all files. */
  done: number
  total: number
}

export interface CreateShareInput {
  payload: SharePayload
  ttlSeconds?: number
  maxViews?: number
  burnAfterRead?: boolean
  /** Optional extra passphrase, shared out-of-band (never in the URL). */
  passphrase?: string
  /** Local owner namespace used to authorize domain-specific revocation. */
  ownerScope?: string
  /** Files the share carries (ADR-0222). Policy is the caller's: see `lib/filespace/share-files.ts`. */
  files?: CreateShareFile[]
  /** The conversation the share is made from, recorded beside the link. */
  sessionId?: string
  onProgress?: (progress: CreateShareProgress) => void
  signal?: AbortSignal
}

export interface CreatedShare {
  code: string
  /** Full shareable URL including the `#fragment` key. */
  url: string
  expiresAt?: number
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body?.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

function authHeaders(endpoint: ShareEndpoint): HeadersInit {
  if (!endpoint.uploadSecret) throw new ShareNotConfiguredError()
  return {
    Authorization: `Bearer ${endpoint.uploadSecret}`,
    "Content-Type": "application/json",
  }
}

/**
 * Headers for owner-only actions (stats / delete). Sends the per-share
 * `X-Owner-Token` when we have one (new shares), otherwise the upload-secret
 * bearer for legacy shares. Requires at least one credential.
 */
function ownerActionHeaders(endpoint: ShareEndpoint, ownerToken?: string): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (ownerToken) headers["X-Owner-Token"] = ownerToken
  else if (endpoint.uploadSecret) headers["Authorization"] = `Bearer ${endpoint.uploadSecret}`
  if (!ownerToken && !endpoint.uploadSecret) throw new ShareNotConfiguredError()
  return headers
}

/** Resolve an existing link's service, preserving ownership after settings change. */
export async function resolveShareOwnerRequest(
  code: string,
  endpoint?: ShareEndpoint
): Promise<{ baseUrl: string; headers: HeadersInit }> {
  const [configured, row] = await Promise.all([
    endpoint ? Promise.resolve(endpoint) : resolveShareEndpoint(),
    getSharedLinkByCode(code),
  ])
  let baseUrl = configured.baseUrl.replace(/\/+$/, "")
  let uploadSecret = configured.uploadSecret
  if (row) {
    let original: URL
    try {
      original = new URL(row.url)
    } catch {
      throw new ShareRequestError(400, "Invalid stored share URL")
    }
    // Both the current viewer and pre-Phase-4 links identify the original
    // service, including a reverse-proxy path prefix. Never forward fragments.
    const suffix = original.pathname.endsWith("/share/view")
      ? "/share/view"
      : `/v/${encodeURIComponent(code)}`
    if (
      !["http:", "https:"].includes(original.protocol) ||
      original.username ||
      original.password ||
      !original.pathname.endsWith(suffix)
    ) {
      throw new ShareRequestError(400, "Invalid stored share URL")
    }
    const originalBase = original.origin + original.pathname.slice(0, -suffix.length)
    if (row.ownerToken || new URL(baseUrl).href !== new URL(originalBase).href) uploadSecret = ""
    baseUrl = originalBase
  }
  return { baseUrl, headers: ownerActionHeaders({ baseUrl, uploadSecret }, row?.ownerToken) }
}

async function hashShareFiles(
  files: CreateShareFile[],
  input: CreateShareInput
): Promise<ShareFileEntry[]> {
  const sources = await Promise.all(files.map((file) => file.open()))
  const violations = checkShareSelectionLimits(
    files.map((file, index) => ({ path: file.path, size: sources[index].size }))
  )
  if (violations.length > 0) throw new ShareFilesTooLargeError(violations)
  const total = sources.reduce((sum, source) => sum + source.size, 0)
  const entries: ShareFileEntry[] = []
  let before = 0
  for (const [index, file] of files.entries()) {
    entries.push(
      await prepareShareFileEntry(file, sources[index], {
        signal: input.signal,
        onProgress: (done) =>
          input.onProgress?.({
            phase: "hashing",
            fileIndex: index,
            fileCount: files.length,
            path: file.path,
            done: before + done,
            total,
          }),
      })
    )
    before += sources[index].size
  }
  return entries
}

/** Withdraw a share whose files did not all arrive. True when it is gone. */
async function withdrawShare(baseUrl: string, code: string, ownerToken: string): Promise<boolean> {
  try {
    const res = await proxyFetch(`${baseUrl}/v1/share/${encodeURIComponent(code)}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": ownerToken, "Content-Type": "application/json" },
    })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

/** Create a share link and mirror it locally. */
export async function createShareLink(
  input: CreateShareInput,
  endpoint?: ShareEndpoint
): Promise<CreatedShare> {
  const ep = endpoint ?? (await resolveShareEndpoint())
  const headers = authHeaders(ep)
  const files = input.files ?? []

  const entries = files.length > 0 ? await hashShareFiles(files, input) : []
  const payload: SharePayload =
    entries.length > 0 ? { ...input.payload, files: entries } : input.payload

  const key = generateShareKey()
  const material = await prepareShareKeyMaterial(key, input.passphrase)
  const envelope = await encryptSharePayloadWithMaterial(payload, material)

  const body: CreateShareRequest = {
    envelope,
    passphrase: Boolean(envelope.pp),
    ttlSeconds: input.ttlSeconds,
    maxViews: input.burnAfterRead ? 1 : input.maxViews,
    burnAfterRead: input.burnAfterRead,
  }
  const serializedBody = JSON.stringify(body)
  assertShareRequestSize(serializedBody)

  const res = await proxyFetch(`${ep.baseUrl}/v1/share`, {
    method: "POST",
    headers,
    body: serializedBody,
    signal: input.signal,
  })
  if (!res.ok) throw new ShareRequestError(res.status, await readError(res))

  const { code, ownerToken, expiresAt } = (await res.json()) as CreateShareResponse
  const url = `${ep.baseUrl}/share/view?c=${code}#k=${encodeShareKey(key)}`

  const row: Omit<SharedLinkRow, "id" | "revoked"> = {
    code,
    kind: payload.kind,
    title: payload.title,
    url,
    createdAt: Date.now(),
    expiresAt,
    maxViews: body.maxViews,
    burnAfterRead: Boolean(input.burnAfterRead),
    hasPassphrase: Boolean(input.passphrase),
    ownerToken,
    ownerScope: input.ownerScope,
    files: entries.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })),
    sessionId: input.sessionId,
  }

  if (entries.length > 0) {
    try {
      // Blob uploads authenticate with the per-share owner token; a server
      // that mints none predates file blobs.
      if (!ownerToken) throw new ShareRequestError(501, "The share server does not accept files")
      const total = entries.reduce((sum, entry) => sum + entry.size, 0)
      let before = 0
      for (const [index, entry] of entries.entries()) {
        await uploadShareBlob({
          baseUrl: ep.baseUrl,
          code,
          ownerToken,
          material: material.bytes,
          entry,
          source: await files[index].open(),
          fetchImpl: proxyFetch,
          signal: input.signal,
          onProgress: (done) =>
            input.onProgress?.({
              phase: "uploading",
              fileIndex: index,
              fileCount: entries.length,
              path: entry.path,
              done: before + done,
              total,
            }),
        })
        before += entry.size
      }
    } catch (error) {
      const revoked = ownerToken ? await withdrawShare(ep.baseUrl, code, ownerToken) : false
      if (!revoked) await recordSharedLink(row)
      throw new ShareFilesUploadError(revoked, error)
    }
  }

  await recordSharedLink(row)

  // Plugin hook — fragment-stripped URL only (the `#k=` decryption key is
  // never exposed to plugin hooks). Best-effort.
  void getPluginEventHooks().dispatchShareLinkCreate({
    code,
    kind: payload.kind,
    title: payload.title,
    url: `${ep.baseUrl}/share/view?c=${code}`,
    expiresAt,
  })

  return { code, url, expiresAt }
}

/** Revoke a share on the worker and flag the local mirror. */
export async function revokeShareLink(code: string, endpoint?: ShareEndpoint): Promise<void> {
  const { baseUrl, headers } = await resolveShareOwnerRequest(code, endpoint)
  const res = await proxyFetch(`${baseUrl}/v1/share/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers,
  })
  // 404 means it's already gone (expired/burned) — treat as success.
  if (!res.ok && res.status !== 404) {
    throw new ShareRequestError(res.status, await readError(res))
  }
  await markSharedLinkRevoked(code)
  void getPluginEventHooks().dispatchShareLinkRevoke(code)
}

/** Owner-only live stats (view count / expiry / revoked). Null if not found. */
export async function getShareStats(
  code: string,
  endpoint?: ShareEndpoint
): Promise<ShareStats | null> {
  const { baseUrl, headers } = await resolveShareOwnerRequest(code, endpoint)
  const res = await proxyFetch(`${baseUrl}/v1/share/${encodeURIComponent(code)}/stats`, {
    method: "GET",
    headers,
  })
  if (res.status === 404) return null
  if (!res.ok) throw new ShareRequestError(res.status, await readError(res))
  return (await res.json()) as ShareStats
}
