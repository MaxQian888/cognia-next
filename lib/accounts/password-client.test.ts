import { invoke } from "@tauri-apps/api/core"

import {
  ACCOUNT_PASSWORD_CREATE_VERIFIER_COMMAND,
  ACCOUNT_PASSWORD_ROTATE_COMMAND,
  ACCOUNT_PASSWORD_VERIFY_COMMAND,
  ACCOUNT_UNBIND_LOCAL_COMMAND,
  createPasswordVerifier,
  rotateNativePassword,
  unbindLocalAccount,
  verifyPassword,
} from "./password-client"
import type { PasswordVerifierRecord } from "./account-types"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

let tauriRuntime = true
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => tauriRuntime,
}))

const invokeMock = invoke as jest.MockedFunction<typeof invoke>

const verifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "salt-b64",
  hash: "hash-b64",
  params: {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLength: 32,
  },
}

describe("password-client", () => {
  beforeEach(() => {
    tauriRuntime = true
    invokeMock.mockReset()
  })

  it("creates a password verifier through the Tauri KDF command", async () => {
    invokeMock.mockResolvedValueOnce(verifier)

    await expect(createPasswordVerifier("correct horse")).resolves.toEqual(verifier)

    expect(invokeMock).toHaveBeenCalledWith(ACCOUNT_PASSWORD_CREATE_VERIFIER_COMMAND, {
      password: "correct horse",
    })
  })

  it("verifies a password through the Tauri KDF command", async () => {
    invokeMock.mockResolvedValueOnce(true)

    await expect(verifyPassword("correct horse", verifier)).resolves.toBe(true)

    expect(invokeMock).toHaveBeenCalledWith(ACCOUNT_PASSWORD_VERIFY_COMMAND, {
      password: "correct horse",
      verifier,
      accountId: undefined,
    })
  })

  it("passes the account id so a successful verify binds the host", async () => {
    invokeMock.mockResolvedValueOnce(true)

    await expect(verifyPassword("correct horse", verifier, "acct_alpha")).resolves.toBe(true)

    expect(invokeMock).toHaveBeenCalledWith(ACCOUNT_PASSWORD_VERIFY_COMMAND, {
      password: "correct horse",
      verifier,
      accountId: "acct_alpha",
    })
  })

  it("unbinds the host account binding and surfaces a native teardown failure", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await expect(unbindLocalAccount()).resolves.toBeUndefined()
    expect(invokeMock).toHaveBeenCalledWith(ACCOUNT_UNBIND_LOCAL_COMMAND)

    invokeMock.mockRejectedValueOnce(new Error("native error"))
    await expect(unbindLocalAccount()).rejects.toThrow(/restart the app/i)
  })

  it("re-authenticates and rotates the host verifier in one native command", async () => {
    invokeMock.mockResolvedValueOnce(verifier)

    await expect(
      rotateNativePassword("acct_alpha", "old-password", verifier, "new-password")
    ).resolves.toEqual(verifier)

    expect(invokeMock).toHaveBeenCalledWith(ACCOUNT_PASSWORD_ROTATE_COMMAND, {
      accountId: "acct_alpha",
      currentPassword: "old-password",
      currentVerifier: verifier,
      newPassword: "new-password",
      newVerifier: null,
    })

    // Unlike the unbind, this one surfaces: silently skipping it would leave
    // the host pinned to a verifier the account no longer has.
    invokeMock.mockRejectedValueOnce(new Error("native error"))
    await expect(
      rotateNativePassword("acct_alpha", "old-password", verifier, "new-password")
    ).rejects.toThrow("native error")
  })

  it("does not reach the host outside Tauri", async () => {
    tauriRuntime = false

    await expect(unbindLocalAccount()).resolves.toBeUndefined()
    await expect(
      rotateNativePassword("acct_alpha", "old-password", verifier, "new-password")
    ).rejects.toThrow(/desktop runtime/)

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("rejects empty passwords before invoking native code", async () => {
    await expect(createPasswordVerifier("  ")).rejects.toThrow(/password/i)
    await expect(verifyPassword("", verifier)).rejects.toThrow(/password/i)

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("rejects passwords below the minimum length before invoking native code", async () => {
    await expect(createPasswordVerifier("short")).rejects.toThrow(/at least 8/)

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("maps native string failures into Error objects", async () => {
    invokeMock.mockRejectedValueOnce("native unavailable")

    await expect(createPasswordVerifier("correct horse")).rejects.toThrow("native unavailable")
  })

  it("preserves native Error failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("native error"))

    await expect(verifyPassword("correct horse", verifier)).rejects.toThrow("native error")
  })

  it("maps unknown native failures into a generic Error", async () => {
    invokeMock.mockRejectedValueOnce({ code: "E_NATIVE" })

    await expect(verifyPassword("correct horse", verifier)).rejects.toThrow(
      "Native password command failed."
    )
  })

  it("rejects malformed verification results returned by native code", async () => {
    invokeMock.mockResolvedValueOnce("true")

    await expect(verifyPassword("correct horse", verifier)).rejects.toThrow(/malformed result/i)
  })

  it("rejects malformed verifier payloads returned by native code", async () => {
    invokeMock.mockResolvedValueOnce({ algorithm: "argon2id-v1", salt: "", hash: "x", params: {} })

    await expect(createPasswordVerifier("correct horse")).rejects.toThrow(/verifier/i)
  })

  it("rejects non-object verifier payloads and array params returned by native code", async () => {
    invokeMock.mockResolvedValueOnce(null)
    await expect(createPasswordVerifier("correct horse")).rejects.toThrow(/verifier/i)

    invokeMock.mockResolvedValueOnce({
      algorithm: "argon2id-v1",
      salt: "salt-b64",
      hash: "hash-b64",
      params: [],
    })
    await expect(createPasswordVerifier("correct horse")).rejects.toThrow(/verifier/i)
  })

  it("creates and verifies a PBKDF2 verifier in an ordinary browser", async () => {
    tauriRuntime = false

    const browserVerifier = await createPasswordVerifier("correct horse")

    expect(browserVerifier).toMatchObject({
      algorithm: "pbkdf2-sha256-v1",
      params: {
        iterations: 600_000,
        hash: "SHA-256",
        outputLength: 32,
      },
    })
    await expect(verifyPassword("correct horse", browserVerifier)).resolves.toBe(true)
    await expect(verifyPassword("wrong horse", browserVerifier)).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
