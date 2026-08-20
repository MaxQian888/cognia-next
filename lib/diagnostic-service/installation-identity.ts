"use client"

/**
 * The mobile shell's installation identity.
 *
 * The desktop has one in Rust (`cognia_observability::diagnostic_submit`) — the
 * same Ed25519 key that signs a diagnostic package also signs the installation
 * proof, so a crash can be submitted with no user interaction at all. Mobile
 * has no native key, and without one an end user would have to paste an
 * identity-provider token to send a crash report, which nobody will do.
 *
 * WebCrypto grew Ed25519 late (Safari 17, Chrome 137), and Capacitor still
 * ships on WebViews older than both. So this is a *probed* capability, not an
 * assumed one: `supportsInstallationProof` answers honestly and the submission
 * surface falls back to the configured operator grant when the answer is no.
 * A silent failure here would look like "the service rejected your crash".
 *
 * The derivation and the proof layout are byte-compatible with the Rust side —
 * `installation-identity.test.ts` pins both against the same vectors the Rust
 * tests use, because the service reconstructs the signed message from the
 * request fields and a one-character difference fails as "invalid signature".
 */

import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

import { normalizeServiceUrl, type DiagnosticFetch } from "./client"
import type { GrantResponse } from "./types"

const KEYRING_NAMESPACE = "diagnostic-service-installation"

export interface InstallationIdentity {
  /** `inst_` + the first 16 bytes of SHA-256 over the raw public key, hex. */
  installationId: string
  /** Base64 of the raw 32-byte public key, as the service expects. */
  publicKeyBase64: string
  /** Base64 of the 64-byte signature over `message`. */
  sign: (message: string) => Promise<string>
}

export interface InstallationIdentityDeps {
  keyring?: KeyringStore
  subtle?: SubtleCrypto
}

function subtleOf(deps: InstallationIdentityDeps): SubtleCrypto | null {
  if (deps.subtle) return deps.subtle
  return globalThis.crypto?.subtle ?? null
}

let sharedKeyring: KeyringStore | null = null
function keyringOf(deps: InstallationIdentityDeps): KeyringStore {
  if (deps.keyring) return deps.keyring
  sharedKeyring ??= createKeyringStore(KEYRING_NAMESPACE)
  return sharedKeyring
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Whether this WebView can produce an installation proof at all.
 *
 * Probed by actually generating a key rather than sniffing a version: several
 * engines expose `Ed25519` in the algorithm table and then reject it at
 * `generateKey`, and a capability that lies is worse than one that is absent.
 */
export async function supportsInstallationProof(
  deps: InstallationIdentityDeps = {}
): Promise<boolean> {
  const subtle = subtleOf(deps)
  if (!subtle) return false
  try {
    await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
    return true
  } catch {
    return false
  }
}

interface StoredKeyPair {
  /** PKCS#8 private key, base64. */
  privateKey: string
  /** Raw public key, base64. */
  publicKey: string
}

/**
 * Load this installation's identity, creating it on first use.
 *
 * Returns `null` when the platform cannot do Ed25519 — the caller reports the
 * limitation instead of failing a submission with an opaque signature error.
 * The private key lives only in the OS keychain (iOS Keychain / Android
 * Keystore through the shared keyring store), never in Dexie or localStorage.
 */
export async function loadOrCreateInstallationIdentity(
  accountId: string,
  deps: InstallationIdentityDeps = {}
): Promise<InstallationIdentity | null> {
  const subtle = subtleOf(deps)
  if (!subtle) return null
  const keyring = keyringOf(deps)

  let stored: StoredKeyPair | null = null
  const raw = await keyring.load(accountId)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredKeyPair>
      if (typeof parsed.privateKey === "string" && typeof parsed.publicKey === "string") {
        stored = { privateKey: parsed.privateKey, publicKey: parsed.publicKey }
      }
    } catch {
      // A key that will not parse is a key that cannot sign. Regenerating is
      // the only way forward; the cost is that submissions made with the old
      // identity can no longer be withdrawn from this device.
      stored = null
    }
  }

  let privateKey: CryptoKey
  let publicKeyBytes: Uint8Array
  if (stored) {
    try {
      privateKey = await subtle.importKey(
        "pkcs8",
        fromBase64(stored.privateKey).buffer as ArrayBuffer,
        { name: "Ed25519" },
        false,
        ["sign"]
      )
      publicKeyBytes = fromBase64(stored.publicKey)
    } catch {
      return null
    }
  } else {
    let generated: CryptoKeyPair
    try {
      generated = (await subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair
    } catch {
      return null
    }
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", generated.privateKey))
    publicKeyBytes = new Uint8Array(await subtle.exportKey("raw", generated.publicKey))
    await keyring.save(
      accountId,
      JSON.stringify({
        privateKey: toBase64(pkcs8),
        publicKey: toBase64(publicKeyBytes),
      } satisfies StoredKeyPair)
    )
    // Re-import non-extractable: nothing after this point needs to read it out.
    privateKey = await subtle.importKey(
      "pkcs8",
      pkcs8.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["sign"]
    )
  }

  const digest = new Uint8Array(await subtle.digest("SHA-256", publicKeyBytes as BufferSource))
  return {
    installationId: `inst_${toHex(digest.slice(0, 16))}`,
    publicKeyBase64: toBase64(publicKeyBytes),
    sign: async (message: string) => {
      const signature = await subtle.sign(
        { name: "Ed25519" },
        privateKey,
        new TextEncoder().encode(message)
      )
      return toBase64(new Uint8Array(signature))
    },
  }
}

/**
 * The exact string `verify_installation_signature` reconstructs server-side.
 *
 * Exported so the test can pin it: the service rebuilds this from the request
 * fields, and any drift here surfaces as an unexplained 401.
 */
export function installationProofMessage(input: {
  tenantId: string
  projectId: string
  installationId: string
  nonce: string
  timestamp: number
}): string {
  return [
    input.tenantId,
    input.projectId,
    input.installationId,
    input.nonce,
    String(input.timestamp),
  ].join("\n")
}

/** A nonce the service will accept: single-use, 16–128 characters. */
function freshNonce(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * Exchange an installation proof for an uploader grant.
 *
 * No user interaction and no identity provider: the device proves it is the
 * installation it claims to be. Replaying a nonce is refused by the service
 * with `installation_proof_replayed` rather than quietly minting a second
 * grant, which is why the nonce is generated per call.
 */
export async function exchangeAnonymousGrant(options: {
  baseUrl: string
  tenantId: string
  projectId: string
  identity: InstallationIdentity
  fetchImpl: DiagnosticFetch
  now?: () => number
}): Promise<GrantResponse> {
  const timestamp = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const nonce = freshNonce()
  const signature = await options.identity.sign(
    installationProofMessage({
      tenantId: options.tenantId,
      projectId: options.projectId,
      installationId: options.identity.installationId,
      nonce,
      timestamp,
    })
  )
  const base = normalizeServiceUrl(options.baseUrl)
  const response = await options.fetchImpl(`${base}/v1/grants/anonymous`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      tenantId: options.tenantId,
      projectId: options.projectId,
      installationId: options.identity.installationId,
      publicKey: options.identity.publicKeyBase64,
      signature,
      nonce,
      timestamp,
    }),
  })
  if (!response.ok) {
    const { DiagnosticServiceError } = await import("./client")
    let code = `http_${response.status}`
    try {
      const body = (await response.json()) as { error?: { code?: unknown } }
      if (typeof body?.error?.code === "string") code = body.error.code
    } catch {
      // Non-JSON means a gateway answered, not the service.
    }
    throw new DiagnosticServiceError(code, response.status)
  }
  return (await response.json()) as GrantResponse
}
