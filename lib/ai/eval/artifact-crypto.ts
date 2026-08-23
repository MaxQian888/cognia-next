import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { isHeadlessHost } from "@/lib/platform/detect"
import { isTauri } from "@/lib/tauri"

const AES_KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16
const PBKDF2_ITERATIONS = 600_000
const ENVELOPE_AAD = new TextEncoder().encode("cognia-eval-artifact/v1")
const WEB_DATA_KEY_SECRET = "evaluation-artifact-data-key"

export type AccountArtifactDomain = "evaluation" | "performance" | "work-submission" | "human-input"

/**
 * Per-domain key locations. Kept as literals rather than derived from the
 * domain name because these strings address key material already written to
 * users' keyrings and vaults — deriving them would silently orphan every
 * existing ciphertext the day the naming scheme changed.
 */
const ARTIFACT_KEY_LOCATIONS: Record<
  Exclude<AccountArtifactDomain, "evaluation">,
  { keyringNamespace: string; keyIdSuffix: string; vaultSecretName: string }
> = {
  performance: {
    keyringNamespace: "performance-artifacts",
    keyIdSuffix: "performance-data-key",
    vaultSecretName: "performance-artifact-data-key",
  },
  "work-submission": {
    keyringNamespace: "work-submission-artifacts",
    keyIdSuffix: "work-submission-data-key",
    vaultSecretName: "work-submission-artifact-data-key",
  },
  "human-input": {
    keyringNamespace: "human-input-artifacts",
    keyIdSuffix: "human-input-data-key",
    vaultSecretName: "human-input-artifact-data-key",
  },
}

export interface AccountArtifactEncryptedEnvelope {
  version: "cognia-account-artifact/v1"
  algorithm: "AES-GCM"
  iv: Uint8Array
  ciphertext: Uint8Array
}

export interface EvalEncryptedEnvelope {
  version: "cognia-eval-encrypted/v1"
  algorithm: "AES-GCM"
  iv: string
  ciphertext: string
}

export interface EvalWrappedDataKey extends EvalEncryptedEnvelope {
  kdf: {
    algorithm: "PBKDF2"
    hash: "SHA-256"
    iterations: number
    salt: string
  }
}

/**
 * Which secure boundary holds this host's key material.
 *
 * The headless brain is not Tauri, but it *does* have a real secret store
 * (`createKeyringStore` routes it to the same backend). Treating it as "web"
 * sends it to the Browser Vault, which does not exist there — so key
 * provisioning threw instead of using the store that was available all along.
 */
function resolveArtifactPlatform(): "desktop" | "web" {
  return isTauri() || isHeadlessHost() ? "desktop" : "web"
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for evaluation artifacts")
  return globalThis.crypto.subtle
}

function randomBytes(size: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random source is unavailable")
  return globalThis.crypto.getRandomValues(new Uint8Array(size))
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

async function importDataKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (rawKey.byteLength !== AES_KEY_BYTES) throw new Error("Evaluation data keys must be 256-bit")
  return subtle().importKey("raw", bufferSource(rawKey), { name: "AES-GCM" }, false, usages)
}

export async function encryptAccountArtifactBytes(
  rawKey: Uint8Array,
  plainText: Uint8Array,
  additionalData: Uint8Array
): Promise<AccountArtifactEncryptedEnvelope> {
  const key = await importDataKey(rawKey, ["encrypt"])
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: bufferSource(iv), additionalData: bufferSource(additionalData) },
    key,
    bufferSource(plainText)
  )
  return {
    version: "cognia-account-artifact/v1",
    algorithm: "AES-GCM",
    iv,
    ciphertext: new Uint8Array(ciphertext),
  }
}

export async function decryptAccountArtifactBytes(
  rawKey: Uint8Array,
  envelope: AccountArtifactEncryptedEnvelope,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  if (envelope.version !== "cognia-account-artifact/v1" || envelope.algorithm !== "AES-GCM") {
    throw new Error("Unsupported account artifact encryption envelope")
  }
  const key = await importDataKey(rawKey, ["decrypt"])
  const decrypted = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(envelope.iv),
      additionalData: bufferSource(additionalData),
    },
    key,
    bufferSource(envelope.ciphertext)
  )
  return new Uint8Array(decrypted)
}

async function deriveWrappingKey(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  if (!password) throw new Error("An unlocked account password is required")
  const material = await subtle().importKey(
    "raw",
    bufferSource(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: bufferSource(salt), iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

async function encryptBytes(key: CryptoKey, plainText: Uint8Array): Promise<EvalEncryptedEnvelope> {
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: bufferSource(iv), additionalData: bufferSource(ENVELOPE_AAD) },
    key,
    bufferSource(plainText)
  )
  return {
    version: "cognia-eval-encrypted/v1",
    algorithm: "AES-GCM",
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  }
}

async function decryptBytes(key: CryptoKey, envelope: EvalEncryptedEnvelope): Promise<Uint8Array> {
  if (envelope.version !== "cognia-eval-encrypted/v1" || envelope.algorithm !== "AES-GCM") {
    throw new Error("Unsupported evaluation encryption envelope")
  }
  const decrypted = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: bufferSource(decodeBase64(envelope.iv)),
      additionalData: bufferSource(ENVELOPE_AAD),
    },
    key,
    bufferSource(decodeBase64(envelope.ciphertext))
  )
  return new Uint8Array(decrypted)
}

export async function encryptEvalArtifact(
  rawKey: Uint8Array,
  value: unknown
): Promise<EvalEncryptedEnvelope> {
  const key = await importDataKey(rawKey, ["encrypt"])
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(value)))
}

export async function decryptEvalArtifact<T = unknown>(
  rawKey: Uint8Array,
  envelope: EvalEncryptedEnvelope
): Promise<T> {
  const key = await importDataKey(rawKey, ["decrypt"])
  return JSON.parse(new TextDecoder().decode(await decryptBytes(key, envelope))) as T
}

export async function wrapEvalDataKey(
  rawKey: Uint8Array,
  password: string
): Promise<EvalWrappedDataKey> {
  if (rawKey.byteLength !== AES_KEY_BYTES) throw new Error("Evaluation data keys must be 256-bit")
  const salt = randomBytes(SALT_BYTES)
  const wrappingKey = await deriveWrappingKey(password, salt, PBKDF2_ITERATIONS)
  return {
    ...(await encryptBytes(wrappingKey, rawKey)),
    kdf: {
      algorithm: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: encodeBase64(salt),
    },
  }
}

export async function unwrapEvalDataKey(
  envelope: EvalWrappedDataKey,
  password: string
): Promise<Uint8Array> {
  if (envelope.kdf.algorithm !== "PBKDF2" || envelope.kdf.hash !== "SHA-256") {
    throw new Error("Unsupported evaluation key wrapping policy")
  }
  const key = await deriveWrappingKey(
    password,
    decodeBase64(envelope.kdf.salt),
    envelope.kdf.iterations
  )
  return decryptBytes(key, envelope)
}

export async function loadOrCreateDesktopEvalKey(
  accountId: string,
  store: KeyringStore
): Promise<Uint8Array> {
  if (!accountId) throw new Error("An account id is required for evaluation encryption")
  const keyId = `account:${accountId}:data-key`
  const existing = await store.load(keyId)
  if (existing) return decodeBase64(existing)
  const created = randomBytes(AES_KEY_BYTES)
  await store.save(keyId, encodeBase64(created))
  return created
}

interface EvalBrowserVault {
  accountId: string
  loadSecret(name: string): Promise<string | null>
  storeSecret(name: string, value: string): Promise<void>
}

export interface EvalArtifactKeyDependencies {
  platform?: "desktop" | "web"
  keyringStore?: KeyringStore
  getBrowserVault?: () => EvalBrowserVault | null
}

export async function loadOrCreateAccountArtifactKey(
  accountId: string,
  domain: AccountArtifactDomain,
  dependencies: EvalArtifactKeyDependencies = {}
): Promise<Uint8Array> {
  if (!accountId) throw new Error("An account id is required for artifact encryption")
  if (domain === "evaluation") return loadOrCreateEvalArtifactKey(accountId, dependencies)
  const location = ARTIFACT_KEY_LOCATIONS[domain]
  const platform = dependencies.platform ?? resolveArtifactPlatform()
  if (platform === "desktop") {
    const store = dependencies.keyringStore ?? createKeyringStore(location.keyringNamespace)
    const keyId = `account:${accountId}:${location.keyIdSuffix}`
    const existing = await store.load(keyId)
    if (existing) return decodeBase64(existing)
    const created = randomBytes(AES_KEY_BYTES)
    await store.save(keyId, encodeBase64(created))
    return created
  }
  const vault = (dependencies.getBrowserVault ?? getActiveBrowserVault)()
  if (!vault || vault.accountId !== accountId) {
    throw new Error(`An unlocked account vault is required for ${domain} encryption`)
  }
  const existing = await vault.loadSecret(location.vaultSecretName)
  if (existing) return decodeBase64(existing)
  const created = randomBytes(AES_KEY_BYTES)
  await vault.storeSecret(location.vaultSecretName, encodeBase64(created))
  return created
}

/**
 * Resolve the account-scoped artifact data key from the platform's existing
 * secure boundary. Desktop persists the random key in the OS keyring. Web
 * stores it as a Browser Vault secret, so a password change only rewraps the
 * vault master key and never rewrites retained evaluation artifacts.
 */
export async function loadOrCreateEvalArtifactKey(
  accountId: string,
  dependencies: EvalArtifactKeyDependencies = {}
): Promise<Uint8Array> {
  if (!accountId) throw new Error("An account id is required for evaluation encryption")
  const platform = dependencies.platform ?? resolveArtifactPlatform()
  if (platform === "desktop") {
    return loadOrCreateDesktopEvalKey(
      accountId,
      dependencies.keyringStore ?? createKeyringStore("eval-artifacts")
    )
  }

  const vault = (dependencies.getBrowserVault ?? getActiveBrowserVault)()
  if (!vault || vault.accountId !== accountId) {
    throw new Error("An unlocked account vault is required for evaluation encryption")
  }
  const existing = await vault.loadSecret(WEB_DATA_KEY_SECRET)
  if (existing) {
    const decoded = decodeBase64(existing)
    if (decoded.byteLength !== AES_KEY_BYTES) {
      throw new Error("Stored evaluation data key is malformed")
    }
    return decoded
  }
  const created = randomBytes(AES_KEY_BYTES)
  await vault.storeSecret(WEB_DATA_KEY_SECRET, encodeBase64(created))
  return created
}

export function createEvalDataKey(): Uint8Array {
  return randomBytes(AES_KEY_BYTES)
}
