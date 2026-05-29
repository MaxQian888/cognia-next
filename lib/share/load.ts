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
  decryptShareEnvelope,
  envelopeRequiresPassphrase,
  SharePassphraseRequiredError,
  ShareIntegrityError,
} from "./crypto"
import type { SharePayload, ShareEnvelopeV1, ReadShareResponse } from "./types"

/** Stable, translatable failure reasons for a `{ status: "error" }` state. */
export type ShareLoadErrorReason = "not-a-link" | "network" | "invalid-key" | "integrity"

export type ShareLoadState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "passphrase"; envelope: ShareEnvelopeV1; key: string; wrong?: boolean }
  | { status: "error"; reason: ShareLoadErrorReason }
  | { status: "ready"; payload: SharePayload }

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

/** Decrypt an envelope into a payload, mapping crypto errors to a load state. */
export async function decryptEnvelope(
  envelope: ShareEnvelopeV1,
  keyB64: string,
  passphrase?: string
): Promise<ShareLoadState> {
  try {
    const payload = await decryptShareEnvelope(envelope, decodeShareKey(keyB64), passphrase)
    return { status: "ready", payload }
  } catch (err) {
    if (err instanceof SharePassphraseRequiredError) {
      return { status: "passphrase", envelope, key: keyB64 }
    }
    if (err instanceof ShareIntegrityError) {
      return { status: "error", reason: "integrity" }
    }
    // Wrong key, or wrong passphrase on a protected share.
    if (envelopeRequiresPassphrase(envelope) && passphrase !== undefined) {
      return { status: "passphrase", envelope, key: keyB64, wrong: true }
    }
    return { status: "error", reason: "invalid-key" }
  }
}

/** Full flow: parse → fetch → decrypt. The UI handles the passphrase round-trip. */
export async function loadShare(
  baseUrl: string,
  search: string,
  hash: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareLoadState> {
  const loc = parseShareLocation(search, hash)
  if (!loc) return { status: "error", reason: "not-a-link" }

  let envelope: ShareEnvelopeV1 | null
  try {
    envelope = await fetchEnvelope(baseUrl, loc.code, fetchImpl)
  } catch {
    return { status: "error", reason: "network" }
  }
  if (!envelope) return { status: "unavailable" }

  return decryptEnvelope(envelope, loc.key)
}
