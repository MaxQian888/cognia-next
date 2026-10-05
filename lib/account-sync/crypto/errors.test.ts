import { AccountSyncCryptoError } from "./errors"

describe("AccountSyncCryptoError", () => {
  it("carries a code and the cause", () => {
    const cause = new Error("inner")
    const error = new AccountSyncCryptoError("key_commitment", "nope", { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("AccountSyncCryptoError")
    expect(error.code).toBe("key_commitment")
    expect(error.message).toBe("nope")
    expect(error.cause).toBe(cause)
  })
})
