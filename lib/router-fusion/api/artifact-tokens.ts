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
 * The signing key belongs to the account, not to the process. A brain that
 * restarts — a reloaded window, a headless brain its supervisor brought back —
 * or a second brain serving the same account from the same vault must accept a
 * link the first one issued a few seconds earlier, so the key is a 256-bit
 * secret created once per account and kept in the account's Browser Vault
 * (`storeSecret`), sealed under the vault's master key like every other vault
 * secret. It is loaded once per account per process and never written in the
 * clear.
 *
 * A database that is not account-scoped (the legacy single database, tests)
 * has no vault, exactly as its fusion content is not encrypted; there the key
 * is per process, and a restart costs a client one more metadata request. A
 * vault that exists but is locked is a fault, not a reason to fall back: the
 * artifact content behind the link cannot be read without it either.
 */

import { decodeBase64Url, encodeBase64Url } from "@/lib/share/encoding"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"

import { RouterFusionInfrastructureError } from "../gate/faults"

/** Spec §16: short-lived read URLs default to 60 seconds. */
export const ARTIFACT_READ_TOKEN_TTL_MS = 60_000

/** The vault secret the account's signing key is stored under. */
export const ARTIFACT_TOKEN_KEY_SECRET = "router-fusion.artifact-read-token-key.v1"

const KEY_BYTES = 32

/** The account's key, per account id, for the life of this process. */
const accountKeys = new Map<string, Promise<CryptoKey>>()
/** The key for a host with no vault at all. */
let processKey: Promise<CryptoKey> | null = null

function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  ) as Promise<CryptoKey>
}

function decodeStoredKey(stored: string): Uint8Array | null {
  try {
    const raw = decodeBase64Url(stored)
    return raw.length === KEY_BYTES ? raw : null
  } catch {
    return null
  }
}

async function loadAccountKey(vault: {
  loadSecret(name: string): Promise<string | null>
  storeSecret(name: string, value: string): Promise<void>
}): Promise<CryptoKey> {
  const existing = await vault.loadSecret(ARTIFACT_TOKEN_KEY_SECRET)
  const decoded = existing === null ? null : decodeStoredKey(existing)
  if (decoded) return importHmacKey(decoded)
  // First use for this account (or a stored value this build cannot read,
  // which could only ever have signed links that are already void). Mint,
  // store, then read back: when two brains of the account race to mint, the
  // read-back converges this one on whichever write landed last.
  const minted = globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES))
  await vault.storeSecret(ARTIFACT_TOKEN_KEY_SECRET, encodeBase64Url(minted))
  const stored = decodeStoredKey((await vault.loadSecret(ARTIFACT_TOKEN_KEY_SECRET)) ?? "")
  return importHmacKey(stored ?? minted)
}

function key(): Promise<CryptoKey> {
  const vault = getActiveBrowserVault()
  if (!vault) {
    processKey ??= globalThis.crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]) as Promise<CryptoKey>
    return processKey
  }
  if (!vault.isUnlocked()) {
    return Promise.reject(
      new RouterFusionInfrastructureError(
        "cipher_locked",
        "The account vault is locked; Router + Fusion cannot sign or check artifact links."
      )
    )
  }
  let pending = accountKeys.get(vault.accountId)
  if (!pending) {
    pending = loadAccountKey(vault)
    accountKeys.set(vault.accountId, pending)
    // A failed load is not remembered: the next request tries again.
    const loading = pending
    const accountId = vault.accountId
    loading.catch(() => {
      if (accountKeys.get(accountId) === loading) accountKeys.delete(accountId)
    })
  }
  return pending
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

/** Forget every key this process loaded, as a restart would. Stored keys stay. */
export function __resetArtifactTokenKeyForTesting(): void {
  accountKeys.clear()
  processKey = null
}
