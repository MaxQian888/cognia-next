/**
 * Crypto Helpers for Plugin Storage Encryption
 *
 * Provides AES-GCM encryption using the Web Crypto API (SubtleCrypto).
 * Used by the Storage API to support encrypted key-value storage.
 */

const ALGORITHM = "AES-GCM"
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96 bits recommended for AES-GCM
const SALT_PREFIX = "cognia:plugin:encryption:"

/**
 * Derive an AES-GCM encryption key from a plugin ID.
 * Uses PBKDF2 with a deterministic salt derived from the plugin ID.
 */
export async function deriveKey(pluginId: string, salt?: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pluginId),
    "PBKDF2",
    false,
    ["deriveKey"]
  )

  const saltBytes = encoder.encode(salt ?? `${SALT_PREFIX}${pluginId}`)

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Encrypt a string using AES-GCM.
 * Returns a base64 string with the IV prepended to the ciphertext.
 */
export async function encrypt(data: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder()
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoder.encode(data))

  // Prepend IV to ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt a base64 string that was encrypted with `encrypt`.
 * Expects the IV prepended to the ciphertext.
 */
export async function decrypt(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))

  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)

  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)

  return new TextDecoder().decode(plaintext)
}
