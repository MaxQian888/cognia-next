// Round-trip tests for the AES-GCM + PBKDF2 encryption helpers used by the
// v3 backup format. WebCrypto is available in jsdom under recent Node versions
// via `globalThis.crypto`; the module also falls back to `node:crypto` if not.

import { sha256Hex, encryptBackupPackage, decryptBackupPackage } from "./crypto"
import { IntegrityCheckFailedError, type BackupManifestV3 } from "./types"

const SAMPLE_PLAINTEXT = JSON.stringify({ hello: "world", n: 42, nested: { a: [1, 2, 3] } })

const MANIFEST: Omit<BackupManifestV3, "integrity"> = {
  version: "3.0",
  schemaVersion: 3,
  traceId: "trace-1",
  exportedAt: "2024-01-01T00:00:00.000Z",
  appVersion: "0.1.0",
  backend: "web-dexie",
}

describe("sha256Hex", () => {
  it("matches a known SHA-256 vector for the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("is stable across calls and case-sensitive", async () => {
    const a = await sha256Hex("payload")
    const b = await sha256Hex("payload")
    const c = await sha256Hex("PAYLOAD")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it("produces 64 lowercase hex chars", async () => {
    const hex = await sha256Hex("anything")
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("encryptBackupPackage / decryptBackupPackage", () => {
  it("round-trips a plaintext through AES-GCM with a passphrase", async () => {
    const env = await encryptBackupPackage(SAMPLE_PLAINTEXT, "passphrase-1", MANIFEST)
    expect(env.version).toBe("enc-v1")
    expect(env.algorithm).toBe("AES-GCM")
    expect(env.kdf.algorithm).toBe("PBKDF2")
    expect(env.kdf.iterations).toBeGreaterThan(0)
    expect(typeof env.iv).toBe("string")
    // Salt is nested under env.kdf.salt — never at the top level.
    expect(typeof env.kdf.salt).toBe("string")

    const recovered = await decryptBackupPackage(env, "passphrase-1")
    expect(recovered).toBe(SAMPLE_PLAINTEXT)
  })

  it("produces a different ciphertext for the same plaintext (random salt+iv)", async () => {
    const a = await encryptBackupPackage("dup", "pass", MANIFEST)
    const b = await encryptBackupPackage("dup", "pass", MANIFEST)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.iv).not.toBe(b.iv)
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
  })

  it("rejects a wrong passphrase", async () => {
    const env = await encryptBackupPackage(SAMPLE_PLAINTEXT, "good", MANIFEST)
    // WebCrypto rejects with `OperationError`, which is a `DOMException` (not a
    // subclass of `Error` in jsdom). Just verify the call rejects.
    await expect(decryptBackupPackage(env, "bad")).rejects.toBeDefined()
  })

  it("throws IntegrityCheckFailedError when the stored checksum is tampered", async () => {
    const env = await encryptBackupPackage(SAMPLE_PLAINTEXT, "good", MANIFEST)
    // Replace the checksum with a wrong value. We must keep the same shape so
    // the function gets to the integrity-check branch; the decrypt itself
    // succeeds because the ciphertext + key are still good.
    const tampered = { ...env, checksum: "0".repeat(64) }
    await expect(decryptBackupPackage(tampered, "good")).rejects.toBeInstanceOf(
      IntegrityCheckFailedError
    )
  })

  it("checksum equals sha256(plaintext)", async () => {
    const env = await encryptBackupPackage(SAMPLE_PLAINTEXT, "p", MANIFEST)
    expect(env.checksum).toBe(await sha256Hex(SAMPLE_PLAINTEXT))
  })
})
