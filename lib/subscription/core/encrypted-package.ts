// Encrypted export / import format for the unified subscription module.
//
// Uses the same crypto primitives the `lib/data/` Dexie-wide backup does
// (PBKDF2-SHA256 600k + AES-GCM-256) but ships a simpler envelope sized for
// just the three provider vaults. The smaller payload keeps backup files
// human-readable in tooling and makes it obvious which vaults are inside.

import type { Account, ProviderId, ProviderPreset, ProviderVault } from "@/types/subscription"

const PBKDF2_ITERATIONS = 600_000
const PBKDF2_HASH = "SHA-256"
const AES_KEY_LENGTH = 256

export const SUBSCRIPTION_PACKAGE_VERSION = "subscription-v1" as const

export interface SubscriptionPackageManifest {
  /** "subscription-v1" — bumped on any breaking schema change. */
  version: typeof SUBSCRIPTION_PACKAGE_VERSION
  /** ISO-8601 timestamp the file was created at. */
  createdAtIso: string
  /** Provider ids present in this backup. */
  providers: ProviderId[]
  /** Account count per provider. */
  accountCount: Record<ProviderId, number>
  /**
   * Provenance of the producing device (additive 2026-06-07; older packages
   * lack it). Generic label, never the raw user agent — mirrors
   * `BackupManifestV3.device`. Rides cleartext in the envelope so restore
   * previews can show "from Windows desktop" without decrypting.
   */
  device?: {
    id: string
    label?: string
    platform?: string
  }
}

export interface SubscriptionPackageBody {
  manifest: SubscriptionPackageManifest
  vaults: Partial<Record<ProviderId, ProviderVault>>
}

export interface SubscriptionEncryptedEnvelope {
  format: "cogniabak-subscription-v1"
  algorithm: "AES-GCM"
  kdf: {
    name: "PBKDF2"
    hash: typeof PBKDF2_HASH
    iterations: number
    /** Base64 of the per-file PBKDF2 salt (16 bytes). */
    saltB64: string
  }
  /** Base64 of the per-file AES-GCM IV (12 bytes). */
  ivB64: string
  /** Base64 of the AES-GCM ciphertext (auth tag appended). */
  ciphertextB64: string
  /** Manifest is exposed in plaintext for forensic inspection. */
  manifest: SubscriptionPackageManifest
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) {
    throw new Error("Web Crypto API (crypto.subtle) is required but unavailable")
  }
  return s
}

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len)
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random source unavailable")
  }
  globalThis.crypto.getRandomValues(buf)
  return buf
}

function bytesToBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = ""
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }
  return Buffer.from(bytes).toString("base64")
}

function fromBase64(s: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(s)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(s, "base64"))
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await subtle().importKey(
    "raw",
    bytesToBuffer(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      salt: bytesToBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Build a `SubscriptionPackageBody` from per-provider vault snapshots. The
 * renderer typically fetches these via `subscription_list_accounts` +
 * `subscription_get_account` (for the full credential bytes) +
 * `subscription_get_preset` + `subscription_get_active`.
 */
export function buildSubscriptionPackage(
  vaults: Partial<Record<ProviderId, ProviderVault>>,
  nowMs: number = Date.now(),
  device?: SubscriptionPackageManifest["device"]
): SubscriptionPackageBody {
  const providers = (Object.keys(vaults) as ProviderId[]).sort()
  const accountCount: Record<ProviderId, number> = {
    anthropic: 0,
    codex: 0,
    opencode: 0,
  }
  for (const provider of providers) {
    accountCount[provider] = vaults[provider]?.accounts.length ?? 0
  }
  return {
    manifest: {
      version: SUBSCRIPTION_PACKAGE_VERSION,
      createdAtIso: new Date(nowMs).toISOString(),
      providers,
      accountCount,
      ...(device ? { device } : {}),
    },
    vaults,
  }
}

/**
 * Encrypt a subscription package with a user-supplied passphrase. Throws
 * when the passphrase is empty (zero-length is a contract bug, never a
 * real user choice).
 */
export async function encryptSubscriptionPackage(
  body: SubscriptionPackageBody,
  passphrase: string
): Promise<SubscriptionEncryptedEnvelope> {
  if (!passphrase) throw new Error("passphrase must not be empty")
  const plaintext = JSON.stringify(body)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(passphrase, salt)
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: bytesToBuffer(iv) },
    key,
    bytesToBuffer(new TextEncoder().encode(plaintext))
  )
  return {
    format: "cogniabak-subscription-v1",
    algorithm: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: PBKDF2_HASH,
      iterations: PBKDF2_ITERATIONS,
      saltB64: toBase64(salt),
    },
    ivB64: toBase64(iv),
    ciphertextB64: toBase64(new Uint8Array(ciphertext)),
    manifest: body.manifest,
  }
}

export class SubscriptionPassphraseError extends Error {
  constructor() {
    super("passphrase did not decrypt the file")
    this.name = "SubscriptionPassphraseError"
  }
}

/**
 * Decrypt a subscription envelope. Returns the body on success, throws
 * `SubscriptionPassphraseError` when AES-GCM auth-tag verification fails
 * (the canonical "wrong passphrase" signal), and a generic error on any
 * other structural problem.
 */
export async function decryptSubscriptionPackage(
  envelope: SubscriptionEncryptedEnvelope,
  passphrase: string
): Promise<SubscriptionPackageBody> {
  if (envelope.format !== "cogniabak-subscription-v1") {
    throw new Error(`unsupported envelope format: ${envelope.format}`)
  }
  if (envelope.algorithm !== "AES-GCM") {
    throw new Error(`unsupported algorithm: ${envelope.algorithm}`)
  }
  if (envelope.kdf.hash !== PBKDF2_HASH) {
    throw new Error(`unsupported KDF hash: ${envelope.kdf.hash}`)
  }
  const salt = fromBase64(envelope.kdf.saltB64)
  const iv = fromBase64(envelope.ivB64)
  const ciphertext = fromBase64(envelope.ciphertextB64)
  const key = await subtle().importKey(
    "raw",
    bytesToBuffer(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  const aesKey = await subtle().deriveKey(
    {
      name: "PBKDF2",
      salt: bytesToBuffer(salt),
      iterations: envelope.kdf.iterations,
      hash: PBKDF2_HASH,
    },
    key,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  )
  let plaintextBuffer: ArrayBuffer
  try {
    plaintextBuffer = await subtle().decrypt(
      { name: "AES-GCM", iv: bytesToBuffer(iv) },
      aesKey,
      bytesToBuffer(ciphertext)
    )
  } catch {
    throw new SubscriptionPassphraseError()
  }
  const plaintext = new TextDecoder().decode(plaintextBuffer)
  let parsed: SubscriptionPackageBody
  try {
    parsed = JSON.parse(plaintext) as SubscriptionPackageBody
  } catch (e) {
    throw new Error(`decrypted body is not valid JSON: ${e instanceof Error ? e.message : e}`)
  }
  if (parsed.manifest?.version !== SUBSCRIPTION_PACKAGE_VERSION) {
    throw new Error(
      `unsupported subscription package version: ${parsed.manifest?.version ?? "unknown"}`
    )
  }
  return parsed
}

/**
 * Helper used by tests + the renderer to sanity-check that a freshly
 * decrypted package contains exactly the accounts we expect.
 */
export function summariseSubscriptionPackage(body: SubscriptionPackageBody): {
  providerCounts: Record<ProviderId, number>
  accountIds: string[]
} {
  const providerCounts: Record<ProviderId, number> = {
    anthropic: 0,
    codex: 0,
    opencode: 0,
  }
  const accountIds: string[] = []
  for (const provider of Object.keys(body.vaults) as ProviderId[]) {
    const vault = body.vaults[provider]
    if (!vault) continue
    providerCounts[provider] = vault.accounts.length
    for (const account of vault.accounts) accountIds.push(account.id)
  }
  return { providerCounts, accountIds }
}

/** Re-export `Account` / `ProviderPreset` so importers don't pull from core/types directly. */
export type { Account, ProviderPreset, ProviderVault }
