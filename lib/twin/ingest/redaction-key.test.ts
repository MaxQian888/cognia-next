/** @jest-environment jsdom */
/**
 * Coverage for the redaction-map encryption helpers. We exercise the
 * Web-mode path (Tauri keyring is opaque to jsdom) — both branches
 * converge on the same `CryptoKey` so round-trip behaviour matches.
 */

import "fake-indexeddb/auto"
import {
  __resetRedactionKey,
  decryptRedactionMap,
  encryptRedactionMap,
  getRedactionKey,
  RedactionKeyMismatchError,
} from "./redaction-key"
import { redactText } from "@cognia/redact"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
})

describe("getRedactionKey", () => {
  it("bootstraps a fresh key on first call and reuses it after", async () => {
    const a = await getRedactionKey()
    const b = await getRedactionKey()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    // CryptoKey objects aren't reference-equal but encrypting the same
    // plaintext with the same IV must round-trip — same key bytes.
    const iv = new Uint8Array(12)
    const plaintext = new TextEncoder().encode("hello")
    const enc1 = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, a, plaintext)
    const dec1 = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, enc1)
    expect(new TextDecoder().decode(dec1)).toBe("hello")
  })
})

describe("encryptRedactionMap / decryptRedactionMap", () => {
  it("round-trips a real redact() output", async () => {
    const { map } = redactText("Email me at alice@example.com or call +14155550100.")
    const blob = await encryptRedactionMap(map)
    expect(blob).toContain('"v":1')
    const decrypted = await decryptRedactionMap(blob)
    expect(decrypted).toEqual(map)
  })

  it("returns an empty string for an empty map (no need to encrypt nothing)", async () => {
    const blob = await encryptRedactionMap({})
    expect(blob).toBe("")
  })

  it("returns {} when decrypting an empty/undefined blob", async () => {
    expect(await decryptRedactionMap(undefined)).toEqual({})
    expect(await decryptRedactionMap("")).toEqual({})
  })

  it("throws on a malformed envelope", async () => {
    await expect(decryptRedactionMap("{}")).rejects.toThrow(/malformed/)
  })

  it("fails decryption when the master key has been rotated", async () => {
    const { map } = redactText("contact bob@example.com")
    const blob = await encryptRedactionMap(map)
    await __resetRedactionKey()
    await expect(decryptRedactionMap(blob)).rejects.toThrow()
  })
})

describe("getRedactionKey — key safety (T0.2)", () => {
  it("throws (does not re-bootstrap) when the key is gone but a fingerprint remains", async () => {
    await getRedactionKey() // records key + fingerprint
    // Simulate the secret store evaporating while the Dexie fingerprint
    // survives — the keyring-mock-restart scenario.
    const db = getDb()
    const row = (await db.settings.get("singleton")) as unknown as Record<string, unknown>
    expect(row.twinRedactionKeyFingerprint).toBeDefined()
    delete row.twinRedactionMasterKey
    await db.settings.put(row as never)
    await expect(getRedactionKey()).rejects.toBeInstanceOf(RedactionKeyMismatchError)
  })

  it("throws on a fingerprint mismatch (key rotated/replaced under a stale fingerprint)", async () => {
    await getRedactionKey()
    const db = getDb()
    const row = (await db.settings.get("singleton")) as unknown as Record<string, unknown>
    // Replace the key with a different valid 32-byte key, leaving the old fp.
    row.twinRedactionMasterKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
    await db.settings.put(row as never)
    await expect(getRedactionKey()).rejects.toBeInstanceOf(RedactionKeyMismatchError)
  })

  it("adopts a fingerprint for a pre-hardening key (present, no fingerprint)", async () => {
    await getRedactionKey()
    const db = getDb()
    const row = (await db.settings.get("singleton")) as unknown as Record<string, unknown>
    delete row.twinRedactionKeyFingerprint // mimic a profile written before this landed
    await db.settings.put(row as never)
    await expect(getRedactionKey()).resolves.toBeDefined()
    const after = (await db.settings.get("singleton")) as unknown as Record<string, unknown>
    expect(after.twinRedactionKeyFingerprint).toBeDefined()
  })

  it("surfaces a typed RedactionKeyMismatchError on a GCM tag failure", async () => {
    const { map } = redactText("contact carol@example.com")
    const blob = await encryptRedactionMap(map)
    await __resetRedactionKey() // clears key + fingerprint
    await getRedactionKey() // bootstraps a NEW key/fingerprint
    await expect(decryptRedactionMap(blob)).rejects.toBeInstanceOf(RedactionKeyMismatchError)
  })
})
