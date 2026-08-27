import { AccountUnlockError, asUnlockError, codeOf } from "./account-unlock-error"

describe("codeOf", () => {
  it("returns the code carried by a typed error", () => {
    expect(codeOf(new AccountUnlockError("throttled"))).toBe("throttled")
  })

  it("maps a Web Crypto OperationError to a wrong password", () => {
    const error = new Error("The operation failed for an operation-specific reason")
    error.name = "OperationError"
    expect(codeOf(error)).toBe("invalid-password")
  })

  it("maps a DOMException OperationError to a wrong password", () => {
    expect(codeOf(new DOMException("bad tag", "OperationError"))).toBe("invalid-password")
  })

  it.each([
    ["Invalid local account password.", "invalid-password"],
    ["Local account password is required.", "password-required"],
    ["Browser Vault password is required.", "password-required"],
    ["Vault recovery key is malformed.", "invalid-recovery-key"],
    ["Browser Vault is not provisioned for this account.", "vault-not-provisioned"],
    ["Browser Vault record is incompatible.", "vault-incompatible"],
    ["This password verifier is not supported in the browser runtime.", "vault-incompatible"],
  ])("classifies the legacy message %p", (message, expected) => {
    expect(codeOf(new Error(message))).toBe(expected)
  })

  it("classifies a bare string the same way as an Error", () => {
    expect(codeOf("Invalid local account password.")).toBe("invalid-password")
  })

  it("falls back to unknown rather than leaking prose", () => {
    expect(codeOf(new Error("ECONNRESET while opening IndexedDB"))).toBe("unknown")
    expect(codeOf(null)).toBe("unknown")
  })
})

describe("asUnlockError", () => {
  it("passes a typed error through untouched", () => {
    const original = new AccountUnlockError("vault-not-provisioned")
    expect(asUnlockError(original)).toBe(original)
  })

  it("wraps an untyped error and keeps the original as cause", () => {
    const original = new Error("Invalid local account password.")
    const wrapped = asUnlockError(original)
    expect(wrapped).toBeInstanceOf(AccountUnlockError)
    expect(wrapped.code).toBe("invalid-password")
    expect((wrapped as { cause?: unknown }).cause).toBe(original)
  })

  it("wraps a non-Error throw", () => {
    const wrapped = asUnlockError("boom")
    expect(wrapped.code).toBe("unknown")
    expect(wrapped.message).toBe("boom")
  })
})
