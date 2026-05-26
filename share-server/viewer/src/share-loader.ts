// Pure loading/decryption orchestration for the viewer, kept out of the React
// component so it can be unit-tested. Reuses the app's already-tested share
// crypto (imported via the `@` alias to the repo root) — the key never leaves
// the browser; it comes from the URL `#fragment`.

import { decodeShareKey } from "@/lib/share/keys"
import {
  decryptShareEnvelope,
  envelopeRequiresPassphrase,
  SharePassphraseRequiredError,
  ShareIntegrityError,
} from "@/lib/share/crypto"
import type { SharePayload, ShareEnvelopeV1, ReadShareResponse } from "@/lib/share/types"

export type LoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "passphrase"; envelope: ShareEnvelopeV1; key: string; wrong?: boolean }
  | { status: "error"; message: string }
  | { status: "ready"; payload: SharePayload }

/** Extract `{ code, key }` from `/v/<code>#k=<key>`. Null if malformed. */
export function parseShareLocation(
  pathname: string,
  hash: string
): { code: string; key: string } | null {
  const m = pathname.match(/\/v\/([^/]+)\/?$/)
  if (!m) return null
  const key = new URLSearchParams(hash.replace(/^#/, "")).get("k")
  if (!key) return null
  return { code: decodeURIComponent(m[1]), key }
}

/** GET the opaque envelope. Returns null on 404 (expired / burned / revoked). */
export async function fetchEnvelope(
  baseUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareEnvelopeV1 | null> {
  const res = await fetchImpl(`${baseUrl}/v1/share/${encodeURIComponent(code)}`, {
    cache: "no-store",
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as ReadShareResponse
  return body.envelope
}

/** Decrypt an envelope into a payload, mapping crypto errors to a LoadState. */
export async function decryptEnvelope(
  envelope: ShareEnvelopeV1,
  keyB64: string,
  passphrase?: string
): Promise<LoadState> {
  try {
    const payload = await decryptShareEnvelope(envelope, decodeShareKey(keyB64), passphrase)
    return { status: "ready", payload }
  } catch (err) {
    if (err instanceof SharePassphraseRequiredError) {
      return { status: "passphrase", envelope, key: keyB64 }
    }
    if (err instanceof ShareIntegrityError) {
      return { status: "error", message: "This share failed its integrity check." }
    }
    // Wrong key, or wrong passphrase on a protected share.
    if (envelopeRequiresPassphrase(envelope) && passphrase !== undefined) {
      return { status: "passphrase", envelope, key: keyB64, wrong: true }
    }
    return { status: "error", message: "This link is invalid or its key is wrong." }
  }
}

/** Full flow: parse → fetch → decrypt. The UI handles the passphrase round-trip. */
export async function loadShare(
  baseUrl: string,
  pathname: string,
  hash: string,
  fetchImpl: typeof fetch = fetch
): Promise<LoadState> {
  const loc = parseShareLocation(pathname, hash)
  if (!loc) return { status: "error", message: "This is not a valid share link." }

  let envelope: ShareEnvelopeV1 | null
  try {
    envelope = await fetchEnvelope(baseUrl, loc.code, fetchImpl)
  } catch {
    return { status: "error", message: "Could not reach the share server." }
  }
  if (!envelope) return { status: "unavailable" }

  return decryptEnvelope(envelope, loc.key)
}
