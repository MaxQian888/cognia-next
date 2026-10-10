// Pure loading/decryption orchestration for the public share viewer, kept out
// of the React component so it can be unit-tested. Reuses the already-tested
// share crypto — the key never leaves the browser; it comes from the URL
// `#fragment`. Errors are returned as stable reason codes (not English
// strings) so the viewer can translate them via next-intl.
//
// URL shape (unified across all kinds, schema v54 / ADR-0037 Phase 4):
//   ${base}/share/view?c=<code>#k=<key>
// The `code` is a public lookup id (query param); the `key` is the secret
// decryption key and stays in the `#fragment`, which browsers never transmit.

import { decodeShareKey } from "./keys"
import {
  openShareEnvelope,
  envelopeRequiresPassphrase,
  SharePassphraseRequiredError,
  ShareIntegrityError,
} from "./crypto"
import type { SharePayload, ShareEnvelopeV1, ReadShareResponse, SharePublicMetadata } from "./types"

/** Stable, translatable failure reasons for a `{ status: "error" }` state. */
export type ShareLoadErrorReason = "not-a-link" | "network" | "invalid-key" | "integrity"

export interface ShareReadRequest {
  baseUrl: string
  code: string
  key: string
}

/**
 * Where an envelope was read and the read ticket that came with it. Carried
 * through a passphrase retry so the files stay reachable without spending
 * another view.
 */
export interface ShareEnvelopeReadContext {
  baseUrl: string
  code: string
  readTicket?: string
  readTicketExpiresAt?: number
}

/**
 * What the viewer needs to download a share's files (ADR-0222): the key
 * material the envelope was opened with — derived once, passphrase included —
 * and the ticket the envelope read issued. `readTicket` is absent when the
 * server predates file blobs or has no ticket key; the files are then listed
 * but cannot be fetched.
 */
export interface ShareFilesAccess extends ShareEnvelopeReadContext {
  material: Uint8Array
}

export type ShareLoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "passphrase-pending"; request: ShareReadRequest; burnAfterRead: boolean }
  | { status: "confirm"; request: ShareReadRequest }
  | {
      status: "passphrase"
      envelope: ShareEnvelopeV1
      key: string
      wrong?: boolean
      read?: ShareEnvelopeReadContext
    }
  | { status: "error"; reason: ShareLoadErrorReason }
  | { status: "ready"; payload: SharePayload; files?: ShareFilesAccess }

/** Extract `{ code, key }` from `?c=<code>` + `#k=<key>`. Null if malformed. */
export function parseShareLocation(
  search: string,
  hash: string
): { code: string; key: string } | null {
  const code = new URLSearchParams(search.replace(/^\?/, "")).get("c")
  const key = new URLSearchParams(hash.replace(/^#/, "")).get("k")
  if (!code || !key) return null
  return { code, key }
}

/**
 * GET the opaque envelope and the read ticket that comes with it. Returns
 * null on 404 (expired / burned / revoked). This is the counted view.
 */
export async function fetchEnvelopeRead(
  baseUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<(ReadShareResponse & { baseUrl: string; code: string }) | null> {
  const res = await fetchImpl(`${baseUrl}/v1/share/${encodeURIComponent(code)}`, {
    cache: "no-store",
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as ReadShareResponse
  return {
    baseUrl,
    code,
    envelope: body.envelope,
    ...(typeof body.readTicket === "string" ? { readTicket: body.readTicket } : {}),
    ...(typeof body.readTicketExpiresAt === "number"
      ? { readTicketExpiresAt: body.readTicketExpiresAt }
      : {}),
  }
}

/** GET the opaque envelope. Returns null on 404 (expired / burned / revoked). */
export async function fetchEnvelope(
  baseUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareEnvelopeV1 | null> {
  return (await fetchEnvelopeRead(baseUrl, code, fetchImpl))?.envelope ?? null
}

/** Decrypt an envelope into a payload, mapping crypto errors to a load state. */
export async function decryptEnvelope(
  envelope: ShareEnvelopeV1,
  keyB64: string,
  passphrase?: string,
  read?: ShareEnvelopeReadContext
): Promise<ShareLoadState> {
  const keep = read ? { read } : {}
  try {
    const { payload, material } = await openShareEnvelope(
      envelope,
      decodeShareKey(keyB64),
      passphrase
    )
    if (read && payload.files && payload.files.length > 0) {
      return { status: "ready", payload, files: { ...read, material } }
    }
    return { status: "ready", payload }
  } catch (err) {
    if (err instanceof SharePassphraseRequiredError) {
      return { status: "passphrase", envelope, key: keyB64, ...keep }
    }
    if (err instanceof ShareIntegrityError) {
      return { status: "error", reason: "integrity" }
    }
    // Wrong key, or wrong passphrase on a protected share.
    if (envelopeRequiresPassphrase(envelope) && passphrase !== undefined) {
      return { status: "passphrase", envelope, key: keyB64, wrong: true, ...keep }
    }
    return { status: "error", reason: "invalid-key" }
  }
}

/** Non-consuming lifecycle lookup. Never falls back to the consuming GET. */
export async function fetchShareMetadata(
  baseUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<SharePublicMetadata | null> {
  const res = await fetchImpl(`${baseUrl}/v1/share/${encodeURIComponent(code)}/metadata`, {
    cache: "no-store",
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body: unknown = await res.json()
  if (!body || typeof body !== "object") throw new Error("Invalid share metadata")
  const metadata = body as SharePublicMetadata
  if (
    typeof metadata.passphrase !== "boolean" ||
    typeof metadata.burnAfterRead !== "boolean" ||
    (metadata.maxViews !== undefined &&
      (!Number.isInteger(metadata.maxViews) || metadata.maxViews < 1))
  ) {
    throw new Error("Invalid share metadata")
  }
  return metadata
}

/** Consume a view only after the recipient has supplied any required passphrase. */
export async function openShare(
  request: ShareReadRequest,
  passphrase?: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareLoadState> {
  let read: Awaited<ReturnType<typeof fetchEnvelopeRead>>
  try {
    read = await fetchEnvelopeRead(request.baseUrl, request.code, fetchImpl)
  } catch {
    return { status: "error", reason: "network" }
  }
  if (!read) return { status: "unavailable" }
  const { envelope, ...context } = read
  // A wrong passphrase retains the envelope (and its read ticket) in the
  // returned state. Retrying decrypts it locally instead of spending another
  // view on the server.
  return decryptEnvelope(envelope, request.key, passphrase, context)
}

/** Parse → inspect lifecycle → gate protected/limited views → fetch and decrypt. */
export async function loadShare(
  baseUrl: string,
  search: string,
  hash: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareLoadState> {
  const loc = parseShareLocation(search, hash)
  if (!loc) return { status: "error", reason: "not-a-link" }
  try {
    decodeShareKey(loc.key)
  } catch {
    return { status: "error", reason: "invalid-key" }
  }
  let metadata: SharePublicMetadata | null
  try {
    metadata = await fetchShareMetadata(baseUrl, loc.code, fetchImpl)
  } catch {
    return { status: "error", reason: "network" }
  }
  if (!metadata) return { status: "unavailable" }
  const request = { baseUrl, ...loc }
  if (metadata.passphrase) {
    return { status: "passphrase-pending", request, burnAfterRead: metadata.burnAfterRead }
  }
  if (metadata.burnAfterRead || metadata.maxViews !== undefined) {
    return { status: "confirm", request }
  }
  return openShare(request, undefined, fetchImpl)
}
