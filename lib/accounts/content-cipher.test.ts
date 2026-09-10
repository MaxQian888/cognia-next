import {
  AccountContentCipher,
  activateAccountContentCipher,
  getActiveAccountContentCipher,
  lockAccountContentCipher,
  __resetAccountContentCipherForTesting,
  type EncryptedContentEnvelope,
} from "./content-cipher"

const ACCOUNT_ID = "acct_cipher"
const DATABASE_NAME = "cognia-account-acct_cipher"

afterEach(__resetAccountContentCipherForTesting)

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
})
