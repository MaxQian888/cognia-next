import { AccountContentCipher } from "./content-cipher"

const ACCOUNT_ID = "acct_cipher"

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
  })
})
