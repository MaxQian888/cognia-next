import { describe, expect, it } from "vitest"

import { bytesToBase64Url } from "../../../../../lib/status/signing"
import { baseEnv } from "../admin/test-support"
import {
  decryptEmail,
  emailHmacs,
  encKeyRing,
  encryptEmail,
  hmacKeyRing,
  subscriberKeysConfigured,
} from "./keys"

const key = (fill: number, length = 32) => bytesToBase64Url(new Uint8Array(length).fill(fill))

describe("subscriber key rings", () => {
  it("parses the configured rings with the current key first", () => {
    const env = {
      ...baseEnv,
      SUBSCRIBER_HMAC_KEYS: JSON.stringify({ old: key(1), new: key(2) }),
      SUBSCRIBER_HMAC_KEY_ID: "new",
    }
    expect(hmacKeyRing(env)?.keys.map((entry) => entry.id)).toEqual(["new", "old"])
    expect(subscriberKeysConfigured(baseEnv)).toBe(true)
  })

  it("refuses short, malformed or missing current keys", () => {
    expect(
      hmacKeyRing({ ...baseEnv, SUBSCRIBER_HMAC_KEYS: JSON.stringify({ h1: key(1, 16) }) })
    ).toBeNull()
    expect(hmacKeyRing({ ...baseEnv, SUBSCRIBER_HMAC_KEYS: "not json" })).toBeNull()
    expect(hmacKeyRing({ ...baseEnv, SUBSCRIBER_HMAC_KEY_ID: "absent" })).toBeNull()
    expect(
      encKeyRing({ ...baseEnv, SUBSCRIBER_ENC_KEYS: JSON.stringify({ e1: key(1, 48) }) })
    ).toBeNull()
  })

  it("computes a stable, key-specific HMAC index", async () => {
    const env = { ...baseEnv, SUBSCRIBER_HMAC_KEYS: JSON.stringify({ h1: key(1), h0: key(2) }) }
    const ring = hmacKeyRing(env)!
    const [current, older] = await emailHmacs(ring, "a@example.com")
    expect(current!.keyId).toBe("h1")
    expect(current!.hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(current!.hmac).not.toBe(older!.hmac)
    expect((await emailHmacs(ring, "a@example.com"))[0]!.hmac).toBe(current!.hmac)
  })

  it("round-trips encryption bound to the subscriber ID and survives rotation", async () => {
    const original = encKeyRing(baseEnv)!
    const sealed = await encryptEmail(original, "sub_1", "a@example.com")
    expect(sealed.keyId).toBe("e1")
    expect(sealed.ciphertext).not.toContain("example")
    expect(await decryptEmail(original, "sub_1", sealed.keyId, sealed.ciphertext)).toBe(
      "a@example.com"
    )
    // Moved to another row: authentication fails.
    expect(await decryptEmail(original, "sub_2", sealed.keyId, sealed.ciphertext)).toBeNull()
    // After rotation the old ciphertext still opens while e1 stays in the ring.
    const rotated = encKeyRing({
      ...baseEnv,
      SUBSCRIBER_ENC_KEYS: JSON.stringify({
        ...JSON.parse(baseEnv.SUBSCRIBER_ENC_KEYS!),
        e2: key(9),
      }),
      SUBSCRIBER_ENC_KEY_ID: "e2",
    })!
    expect(await decryptEmail(rotated, "sub_1", "e1", sealed.ciphertext)).toBe("a@example.com")
    expect((await encryptEmail(rotated, "sub_1", "a@example.com")).keyId).toBe("e2")
    // Once the old key is removed it cannot be read.
    const removed = encKeyRing({
      ...baseEnv,
      SUBSCRIBER_ENC_KEYS: JSON.stringify({ e2: key(9) }),
      SUBSCRIBER_ENC_KEY_ID: "e2",
    })!
    expect(await decryptEmail(removed, "sub_1", "e1", sealed.ciphertext)).toBeNull()
  })
})
