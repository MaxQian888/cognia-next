import {
  AccountContentCipher,
  activateAccountContentCipher,
  getActiveAccountContentCipher,
  lockAccountContentCipher,
  __resetAccountContentCipherForTesting,
  type EncryptedContentEnvelope,
} from "./content-cipher"
import { encodeBase64Url } from "@/lib/share/encoding"

const ACCOUNT_ID = "acct_cipher"
const DATABASE_NAME = "cognia-account-acct_cipher"

afterEach(() => {
  jest.restoreAllMocks()
  __resetAccountContentCipherForTesting()
})

describe("AccountContentCipher", () => {
  it("encrypts JSON with AES-256-GCM and binds the envelope to its storage coordinates", async () => {
    const cipher = await AccountContentCipher.createForTesting(
      ACCOUNT_ID,
      "cognia-account-acct_cipher"
    )
    const value = { text: "highly sensitive prompt", nested: [1, true] }

    const envelope = await cipher.encrypt("messages", "msg_1", "payload", 1, value)

    expect(envelope).toMatchObject({
      version: 1,
      algorithm: "AES-256-GCM",
      accountId: ACCOUNT_ID,
    })
    expect(JSON.stringify(envelope)).not.toContain("highly sensitive prompt")
    await expect(cipher.decrypt("messages", "msg_1", "payload", 1, envelope)).resolves.toEqual(
      value
    )
    await expect(cipher.decrypt("messages", "msg_2", "payload", 1, envelope)).rejects.toBeDefined()
    await expect(cipher.decrypt("artifacts", "msg_1", "payload", 1, envelope)).rejects.toBeDefined()
  })

  it("round-trips byte arrays, which plain JSON would turn into objects", async () => {
    const cipher = await AccountContentCipher.createForTesting(
      ACCOUNT_ID,
      "cognia-account-acct_cipher"
    )
    // A composer draft's staged file: before the tag, `bytes` came back as
    // `{"0":35,…}` and a revived File held "[object Object]".
    const bytes = new TextEncoder().encode("# Design spec — 设计")
    const value = { text: "draft", attachments: [{ name: "DESIGN.md", size: bytes.length, bytes }] }

    const envelope = await cipher.encrypt("chatDrafts", "s1", "payload", 1, value)
    const decrypted = await cipher.decrypt<typeof value>("chatDrafts", "s1", "payload", 1, envelope)

    expect(decrypted.attachments[0]!.bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(decrypted.attachments[0]!.bytes)).toBe("# Design spec — 设计")
    expect(decrypted.attachments[0]!.size).toBe(bytes.length)
  })

  it("leaves objects that merely resemble the tag, and legacy rows, as they were", async () => {
    const cipher = await AccountContentCipher.createForTesting(
      ACCOUNT_ID,
      "cognia-account-acct_cipher"
    )
    const value = {
      notTagged: { $cogniaBytes: "AQI", extra: 1 },
      nonString: { $cogniaBytes: 7 },
      legacyCorrupted: { "0": 35, "1": 32 },
    }
    const envelope = await cipher.encrypt("chatDrafts", "s1", "payload", 1, value)
    await expect(cipher.decrypt("chatDrafts", "s1", "payload", 1, envelope)).resolves.toEqual(value)
  })

  it("rejects use after lock and cross-account envelopes", async () => {
    const cipher = await AccountContentCipher.createForTesting(
      ACCOUNT_ID,
      "cognia-account-acct_cipher"
    )
    const envelope = await cipher.encrypt("messages", "msg_1", "payload", 1, "secret")
    const other = await AccountContentCipher.createForTesting(
      "acct_other",
      "cognia-account-acct_other"
    )

    await expect(other.decrypt("messages", "msg_1", "payload", 1, envelope)).rejects.toThrow(
      /account/i
    )
    cipher.lock()
    await expect(cipher.encrypt("messages", "msg_2", "payload", 1, "secret")).rejects.toThrow(
      /locked/i
    )
    await expect(cipher.decrypt("messages", "msg_1", "payload", 1, envelope)).rejects.toThrow(
      /locked/i
    )
  })

  it("reads existing URL-safe envelopes without changing the stored format", async () => {
    const cipher = await AccountContentCipher.fromRawKey(
      ACCOUNT_ID,
      DATABASE_NAME,
      Uint8Array.from({ length: 32 }, (_, index) => index)
    )
    // Fixed legacy-format vector: key bytes 0..31 and IV bytes 0..11.
    const envelope: EncryptedContentEnvelope = {
      version: 1,
      algorithm: "AES-256-GCM",
      accountId: ACCOUNT_ID,
      iv: "AAECAwQFBgcICQoL",
      ciphertext:
        "PCCifr2R4CGvDfLs0IoBTWZQAtFewn-Mp_N1pzFLbtdyZMuYjftJ9gHIE8H89V1dwmtVuAerYofZA1DzeI-wq3TRGWAb9g",
    }
    await expect(cipher.decrypt("messages", "msg_legacy", "payload", 1, envelope)).resolves.toEqual(
      {
        text: "Legacy 内容 🔐",
        nested: [null, true, 255],
      }
    )
  })

  it.each([0, 1, 2])(
    "round-trips large Unicode payloads with padding offset %i",
    async (offset) => {
      const cipher = await AccountContentCipher.createForTesting(ACCOUNT_ID, DATABASE_NAME)
      const value = { context: "会话🔐\u0000".repeat(4000) + "x".repeat(offset) }
      const envelope = await cipher.encrypt("sessions", "s_large", "payload", 1, value)

      expect(envelope.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/)
      await expect(cipher.decrypt("sessions", "s_large", "payload", 1, envelope)).resolves.toEqual(
        value
      )
    }
  )

  it("rejects corrupted ciphertext and changed authenticated coordinates", async () => {
    const cipher = await AccountContentCipher.createForTesting(ACCOUNT_ID, DATABASE_NAME)
    const envelope = await cipher.encrypt("sessions", "s_1", "payload", 1, { text: "private" })
    const corrupted = {
      ...envelope,
      ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1),
    }
    await expect(cipher.decrypt("sessions", "s_1", "payload", 1, corrupted)).rejects.toBeDefined()
    await expect(cipher.decrypt("sessions", "s_1", "other", 1, envelope)).rejects.toBeDefined()
    await expect(cipher.decrypt("sessions", "s_1", "payload", 2, envelope)).rejects.toBeDefined()
    await expect(
      cipher.decrypt("sessions", "s_1", "payload", 1, { ...envelope, ciphertext: "%" })
    ).rejects.toBeDefined()
  })

  it("rejects incompatible keys, databases and envelope formats", async () => {
    await expect(
      AccountContentCipher.fromRawKey(ACCOUNT_ID, DATABASE_NAME, new Uint8Array(16))
    ).rejects.toThrow(/256 bits/)
    await expect(
      AccountContentCipher.fromRawKey(ACCOUNT_ID, "cognia-account-other", new Uint8Array(32))
    ).rejects.toThrow(/does not belong/)
    const cipher = await AccountContentCipher.createForTesting(ACCOUNT_ID, DATABASE_NAME)
    const envelope = await cipher.encrypt("sessions", "s_1", "payload", 1, "private")
    for (const incompatible of [{ version: 2 }, { algorithm: "other" }]) {
      await expect(
        cipher.decrypt("sessions", "s_1", "payload", 1, {
          ...envelope,
          ...incompatible,
        } as EncryptedContentEnvelope)
      ).rejects.toThrow(/incompatible/)
    }
    for (const [table, field, version] of [
      ["", "payload", 1],
      ["sessions", "", 1],
      ["sessions", "payload", 0],
      ["sessions", "payload", 1.5],
    ] as const) {
      await expect(cipher.encrypt(table, "s_1", field, version, "private")).rejects.toThrow(
        /coordinates/
      )
    }
  })

  it("locks the previous account cipher on switching or explicit locking", async () => {
    const first = await AccountContentCipher.createForTesting(ACCOUNT_ID, DATABASE_NAME)
    const second = await AccountContentCipher.createForTesting(
      "acct_second",
      "cognia-account-acct_second"
    )
    activateAccountContentCipher(first)
    expect(getActiveAccountContentCipher(DATABASE_NAME)).toBe(first)
    expect(getActiveAccountContentCipher("cognia-account-acct_second")).toBeNull()
    activateAccountContentCipher(second)
    await expect(first.encrypt("messages", "m1", "payload", 1, "private")).rejects.toThrow(/locked/)
    lockAccountContentCipher()
    expect(getActiveAccountContentCipher("cognia-account-acct_second")).toBeNull()
    await expect(second.encrypt("messages", "m1", "payload", 1, "private")).rejects.toThrow(
      /locked/
    )
  })

  describe("session list decryption cache", () => {
    const createCipher = () => AccountContentCipher.createForTesting(ACCOUNT_ID, DATABASE_NAME)

    it("avoids walking every property of ordinary cached JSON while returning fresh values", async () => {
      const cipher = await createCipher()
      const value = { title: "普通 title", nested: { enabled: true, labels: ["one", "two"] } }
      const envelope = await cipher.encrypt("sessionList", "plain", "payload", 1, value)
      await cipher.decrypt("sessionList", "plain", "payload", 1, envelope)
      const parse = jest.spyOn(JSON, "parse")
      const first = cipher.getCachedDecrypted<typeof value>(
        "sessionList",
        "plain",
        "payload",
        1,
        envelope
      )!
      first.value.nested.labels.push("changed")
      expect(await cipher.decrypt("sessionList", "plain", "payload", 1, envelope)).toEqual(value)
      expect(parse).toHaveBeenCalledTimes(2)
      expect(parse.mock.calls.every(([, reviver]) => reviver === undefined)).toBe(true)
    })

    it("revives nested binary tags with escaped JSON keys and preserves escaped strings", async () => {
      const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index)
      const cipher = await AccountContentCipher.fromRawKey(ACCOUNT_ID, DATABASE_NAME, rawKey)
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"])
      const iv = new Uint8Array(12).fill(7)
      const json =
        '{"nested":{"\\u0024cogniaBytes":"AQI"},"text":"escaped \\u4f60\\u597d and \\n line"}'
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new TextEncoder().encode(
            JSON.stringify([
              "cognia-content",
              DATABASE_NAME,
              "sessionList",
              "escaped",
              "payload",
              1,
            ])
          ),
        },
        key,
        new TextEncoder().encode(json)
      )
      const envelope: EncryptedContentEnvelope = {
        accountId: ACCOUNT_ID,
        version: 1,
        algorithm: "AES-256-GCM",
        iv: encodeBase64Url(iv),
        ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      }
      const first = await cipher.decrypt<{ nested: Uint8Array; text: string }>(
        "sessionList",
        "escaped",
        "payload",
        1,
        envelope
      )
      first.nested[0] = 99
      const cached = cipher.getCachedDecrypted<{ nested: Uint8Array; text: string }>(
        "sessionList",
        "escaped",
        "payload",
        1,
        envelope
      )!
      expect(cached.value.nested).toBeInstanceOf(Uint8Array)
      expect(cached.value).toEqual({
        nested: new Uint8Array([1, 2]),
        text: "escaped 你好 and \n line",
      })
      cached.value.nested[1] = 99
      expect(await cipher.decrypt("sessionList", "escaped", "payload", 1, envelope)).toEqual({
        nested: new Uint8Array([1, 2]),
        text: "escaped 你好 and \n line",
      })
    })

    it("reuses authenticated projection payloads while returning independent nested values", async () => {
      const cipher = await createCipher()
      const value = { title: "Private title", nested: { bytes: new Uint8Array([1, 2, 3]) } }
      const envelope = await cipher.encrypt("sessionList", "s1", "payload", 1, value)
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")

      const first = await cipher.decrypt<typeof value>("sessionList", "s1", "payload", 1, envelope)
      first.title = "changed by caller"
      first.nested.bytes[0] = 99
      const second = await cipher.decrypt<typeof value>("sessionList", "s1", "payload", 1, {
        ...envelope,
      })

      expect(second).toEqual(value)
      expect(second.nested.bytes).toBeInstanceOf(Uint8Array)
      expect(second.nested).not.toBe(first.nested)
      expect(decrypt).toHaveBeenCalledTimes(1)
    })

    it("exposes only validated cache hits synchronously without sharing mutable payloads", async () => {
      const cipher = await createCipher()
      const envelope = await cipher.encrypt("sessionList", "s1", "payload", 1, {
        nested: { bytes: new Uint8Array([1, 2]) },
      })
      expect(cipher.getCachedDecrypted("sessionList", "s1", "payload", 1, envelope)).toBeUndefined()
      await cipher.decrypt("sessionList", "s1", "payload", 1, envelope)
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")
      const first = cipher.getCachedDecrypted<{ nested: { bytes: Uint8Array } }>(
        "sessionList",
        "s1",
        "payload",
        1,
        envelope
      )!
      first.value.nested.bytes[0] = 99
      expect(cipher.getCachedDecrypted("sessionList", "s1", "payload", 1, envelope)).toEqual({
        value: { nested: { bytes: new Uint8Array([1, 2]) } },
      })
      expect(
        cipher.getCachedDecrypted("sessionList", "other", "payload", 1, envelope)
      ).toBeUndefined()
      expect(cipher.getCachedDecrypted("sessionList", "s1", "payload", 2, envelope)).toBeUndefined()
      expect(cipher.getCachedDecrypted("sessions", "s1", "payload", 1, envelope)).toBeUndefined()
      expect(
        cipher.getCachedDecrypted("sessionList", "s1", "payload", 1, {
          ...envelope,
          ciphertext: envelope.ciphertext + "A",
        })
      ).toBeUndefined()
      expect(() =>
        cipher.getCachedDecrypted("sessionList", "s1", "payload", 1, {
          ...envelope,
          accountId: "other",
        })
      ).toThrow(/account/)
      expect(() => cipher.getCachedDecrypted("sessionList", "s1", "payload", 0, envelope)).toThrow(
        /coordinates/
      )
      expect(decrypt).not.toHaveBeenCalled()
      cipher.lock()
      expect(() => cipher.getCachedDecrypted("sessionList", "s1", "payload", 1, envelope)).toThrow(
        /locked/
      )
    })

    it("does not cache other tables or non-payload fields", async () => {
      const cipher = await createCipher()
      for (const [table, field] of [
        ["sessions", "payload"],
        ["messages", "payload"],
        ["sessionList", "other"],
      ]) {
        const envelope = await cipher.encrypt(table, "s1", field, 1, { title: "private" })
        const decrypt = jest.spyOn(crypto.subtle, "decrypt")
        await cipher.decrypt(table, "s1", field, 1, envelope)
        await cipher.decrypt(table, "s1", field, 1, envelope)
        expect(decrypt).toHaveBeenCalledTimes(2)
        decrypt.mockRestore()
      }
    })

    it("validates full authenticated coordinates and envelope even after warming a row", async () => {
      const cipher = await createCipher()
      const envelope = await cipher.encrypt("sessionList", "s1", "payload", 1, { title: "private" })
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")
      await cipher.decrypt("sessionList", "s1", "payload", 1, envelope)

      for (const [table, id, field, schema] of [
        ["sessionList", "s2", "payload", 1],
        ["sessions", "s1", "payload", 1],
        ["sessionList", "s1", "other", 1],
        ["sessionList", "s1", "payload", 2],
        ["sessionList", "s1", "payload", 0],
        ["sessionList", "s1", "payload", 1.5],
        ["sessionList", "s1", "", 1],
      ] as const) {
        await expect(cipher.decrypt(table, id, field, schema, envelope)).rejects.toBeDefined()
      }
      for (const change of [
        { iv: (envelope.iv[0] === "A" ? "B" : "A") + envelope.iv.slice(1) },
        {
          ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1),
        },
        { accountId: "acct_other" },
        { version: 2 },
        { algorithm: "other" },
      ]) {
        await expect(
          cipher.decrypt("sessionList", "s1", "payload", 1, {
            ...envelope,
            ...change,
          } as EncryptedContentEnvelope)
        ).rejects.toBeDefined()
      }

      const calls = decrypt.mock.calls.length
      await expect(cipher.decrypt("sessionList", "s1", "payload", 1, envelope)).resolves.toEqual({
        title: "private",
      })
      expect(decrypt).toHaveBeenCalledTimes(calls)
    })

    it("binds cached values to the exact AAD serialization, including compound keys", async () => {
      const cipher = await createCipher()
      const key = ["s1", "payload", 2]
      const envelope = await cipher.encrypt("sessionList", key, "payload", 2, { title: "v2" })
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")
      await cipher.decrypt("sessionList", key, "payload", 2, envelope)
      await cipher.decrypt("sessionList", [...key], "payload", 2, envelope)
      expect(decrypt).toHaveBeenCalledTimes(1)
      await expect(
        cipher.decrypt("sessionList", key.join(","), "payload", 2, envelope)
      ).rejects.toBeDefined()
    })

    it("snapshots the envelope before awaiting authentication", async () => {
      const cipher = await createCipher()
      const first = await cipher.encrypt("sessionList", "s1", "payload", 1, { title: "first" })
      const second = await cipher.encrypt("sessionList", "s1", "payload", 1, { title: "second" })
      const decryptActual = crypto.subtle.decrypt.bind(crypto.subtle)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const decrypt = jest
        .spyOn(crypto.subtle, "decrypt")
        .mockImplementationOnce(async (...args) => {
          const plaintext = await decryptActual(...args)
          await gate
          return plaintext
        })
      const mutable = { ...first }
      const pending = cipher.decrypt("sessionList", "s1", "payload", 1, mutable)
      Object.assign(mutable, second)
      release()

      await expect(pending).resolves.toEqual({ title: "first" })
      await expect(cipher.decrypt("sessionList", "s1", "payload", 1, mutable)).resolves.toEqual({
        title: "second",
      })
      expect(decrypt).toHaveBeenCalledTimes(2)
      await cipher.decrypt("sessionList", "s1", "payload", 1, mutable)
      expect(decrypt).toHaveBeenCalledTimes(2)
    })

    it("clears cached plaintext on lock and does not retain a late decrypt result", async () => {
      const cipher = await createCipher()
      const envelope = await cipher.encrypt("sessionList", "s1", "payload", 1, { title: "private" })
      await cipher.decrypt("sessionList", "s1", "payload", 1, envelope)
      const cache = (cipher as unknown as { sessionListCache: Map<string, unknown> })
        .sessionListCache
      expect(cache.size).toBe(1)
      const pendingEnvelope = await cipher.encrypt("sessionList", "s2", "payload", 1, {
        title: "late",
      })
      const decryptActual = crypto.subtle.decrypt.bind(crypto.subtle)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      jest.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
        const plaintext = await decryptActual(...args)
        await gate
        return plaintext
      })
      const pending = cipher.decrypt("sessionList", "s2", "payload", 1, pendingEnvelope)
      cipher.lock()
      expect(cache.size).toBe(0)
      release()
      await expect(pending).resolves.toEqual({ title: "late" })
      expect(cache.size).toBe(0)
      await expect(cipher.decrypt("sessionList", "s1", "payload", 1, envelope)).rejects.toThrow(
        /locked/
      )
    })

    it("never shares authenticated cache entries across cipher replacement or database targets", async () => {
      const first = await createCipher()
      const envelope = await first.encrypt("sessionList", "s1", "payload", 1, { title: "private" })
      activateAccountContentCipher(first)
      await first.decrypt("sessionList", "s1", "payload", 1, envelope)
      const replacement = await createCipher()
      activateAccountContentCipher(replacement)
      await expect(first.decrypt("sessionList", "s1", "payload", 1, envelope)).rejects.toThrow(
        /locked/
      )
      await expect(
        replacement.decrypt("sessionList", "s1", "payload", 1, envelope)
      ).rejects.toBeDefined()
      const target = await AccountContentCipher.createForTesting(
        ACCOUNT_ID,
        `${DATABASE_NAME}-host-two`
      )
      await expect(
        target.decrypt("sessionList", "s1", "payload", 1, envelope)
      ).rejects.toBeDefined()
    })

    it("keeps Host databases isolated even when both ciphers use the same account key", async () => {
      const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index)
      const first = await AccountContentCipher.fromRawKey(ACCOUNT_ID, DATABASE_NAME, rawKey)
      const second = await AccountContentCipher.fromRawKey(
        ACCOUNT_ID,
        `${DATABASE_NAME}-host-two`,
        rawKey
      )
      const firstEnvelope = await first.encrypt("sessionList", "s1", "payload", 1, {
        title: "Host one",
      })
      const secondEnvelope = await second.encrypt("sessionList", "s1", "payload", 1, {
        title: "Host two",
      })
      await first.decrypt("sessionList", "s1", "payload", 1, firstEnvelope)
      await second.decrypt("sessionList", "s1", "payload", 1, secondEnvelope)
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")

      await expect(
        first.decrypt("sessionList", "s1", "payload", 1, secondEnvelope)
      ).rejects.toBeDefined()
      await expect(
        second.decrypt("sessionList", "s1", "payload", 1, firstEnvelope)
      ).rejects.toBeDefined()
      expect(decrypt).toHaveBeenCalledTimes(2)
      await expect(
        first.decrypt("sessionList", "s1", "payload", 1, firstEnvelope)
      ).resolves.toEqual({ title: "Host one" })
      await expect(
        second.decrypt("sessionList", "s1", "payload", 1, secondEnvelope)
      ).resolves.toEqual({ title: "Host two" })
      expect(decrypt).toHaveBeenCalledTimes(2)
    })

    it("evicts the least recently used coordinate beyond 2048 entries", async () => {
      const cipher = await createCipher()
      const envelopes = await Promise.all(
        Array.from({ length: 2049 }, (_, index) =>
          cipher.encrypt("sessionList", `s${index}`, "payload", 1, { title: `row ${index}` })
        )
      )
      for (let index = 0; index < 2048; index++) {
        await cipher.decrypt("sessionList", `s${index}`, "payload", 1, envelopes[index])
      }
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")
      await cipher.decrypt("sessionList", "s0", "payload", 1, envelopes[0])
      await cipher.decrypt("sessionList", "s2048", "payload", 1, envelopes[2048])
      await cipher.decrypt("sessionList", "s0", "payload", 1, envelopes[0])
      expect(decrypt).toHaveBeenCalledTimes(1)
      await cipher.decrypt("sessionList", "s1", "payload", 1, envelopes[1])
      expect(decrypt).toHaveBeenCalledTimes(2)
    })

    it("bounds retained UTF-16 strings by bytes and never caches an oversized row", async () => {
      const cipher = await createCipher()
      const value = { title: "x".repeat(1024 * 1024) }
      const first = await cipher.encrypt("sessionList", "s1", "payload", 1, value)
      const second = await cipher.encrypt("sessionList", "s2", "payload", 1, value)
      await cipher.decrypt("sessionList", "s1", "payload", 1, first)
      await cipher.decrypt("sessionList", "s2", "payload", 1, second)
      const decrypt = jest.spyOn(crypto.subtle, "decrypt")
      await cipher.decrypt("sessionList", "s2", "payload", 1, second)
      expect(decrypt).not.toHaveBeenCalled()
      await cipher.decrypt("sessionList", "s1", "payload", 1, first)
      expect(decrypt).toHaveBeenCalledTimes(1)

      const oversized = await cipher.encrypt("sessionList", "large", "payload", 1, {
        title: value.title + value.title,
      })
      await cipher.decrypt("sessionList", "large", "payload", 1, oversized)
      await cipher.decrypt("sessionList", "large", "payload", 1, oversized)
      expect(decrypt).toHaveBeenCalledTimes(3)
    })
  })
})
