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
} from "./redaction-key"
import { redactText } from "./redact"
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
