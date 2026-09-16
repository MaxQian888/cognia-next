/**
 * Short-lived read tokens for `GET /v1/artifacts/{id}` (ADR-0188 B2, DESIGN §16).
 *
 * The spec hands a client a read URL that expires after sixty seconds and never
 * treats a storage key as a link. Here the URL is the gateway's own content
 * route plus a token, and the token is an HMAC over what it grants: one
 * artifact, one gateway key, one expiry. The route still demands the bearer
 * key and re-checks ownership, so the token only adds the expiry and the
 * binding — a leaked URL is useless to anyone without that key, and useless to
 * that key a minute later.
 *
 * The signing key lives in memory and is minted on first use. A brain that
 * restarts invalidates every outstanding token, which for a sixty-second token
 * costs a client one more metadata request and keeps a secret off the disk.
 */

/** Spec §16: short-lived read URLs default to 60 seconds. */
export const ARTIFACT_READ_TOKEN_TTL_MS = 60_000

let signingKey: Promise<CryptoKey> | null = null

function key(): Promise<CryptoKey> {
  signingKey ??= globalThis.crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]) as Promise<CryptoKey>
  return signingKey
}

function claimOf(artifactId: string, keyId: string | null, expiresAt: number): Uint8Array {
  // NUL cannot occur in an artifact id or a key id, so no two grants spell the same claim.
  return new TextEncoder().encode([artifactId, keyId ?? "local", String(expiresAt)].join("\u0000"))
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = ""
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  try {
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export interface IssuedReadToken {
  token: string
  expiresAt: number
}

export async function issueArtifactReadToken(
  artifactId: string,
  keyId: string | null,
  now: number
): Promise<IssuedReadToken> {
  const expiresAt = now + ARTIFACT_READ_TOKEN_TTL_MS
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await key(),
    claimOf(artifactId, keyId, expiresAt) as BufferSource
  )
  return { token: `${expiresAt}.${toBase64Url(signature)}`, expiresAt }
}

export type ReadTokenVerdict = "valid" | "expired" | "invalid"

export async function verifyArtifactReadToken(
  token: unknown,
  artifactId: string,
  keyId: string | null,
  now: number
): Promise<ReadTokenVerdict> {
  if (typeof token !== "string") return "invalid"
  const dot = token.indexOf(".")
  if (dot <= 0) return "invalid"
  const expiresAt = Number(token.slice(0, dot))
  const signature = fromBase64Url(token.slice(dot + 1))
  if (!Number.isSafeInteger(expiresAt) || !signature) return "invalid"
  const authentic = await globalThis.crypto.subtle.verify(
    "HMAC",
    await key(),
    signature as BufferSource,
    claimOf(artifactId, keyId, expiresAt) as BufferSource
  )
  if (!authentic) return "invalid"
  return expiresAt > now ? "valid" : "expired"
}

export function __resetArtifactTokenKeyForTesting(): void {
  signingKey = null
}
