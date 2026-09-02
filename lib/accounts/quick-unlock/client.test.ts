/** @jest-environment jsdom */

import type { PasswordVerifierRecord } from "@/lib/accounts/account-types"
import { MAX_QUICK_UNLOCK_ATTEMPTS, type QuickUnlockEnrollment } from "./types"

let tauri = false
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => tauri }))

const invoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

const enrollBrowserVaultQuickUnlock = jest.fn(async () => ({ createdAt: 5 }))
const unlockBrowserVaultWithQuickSecret = jest.fn(async () => {})
const removeBrowserVaultQuickUnlock = jest.fn(async () => {})
jest.mock("@/lib/runtime/browser-vault", () => ({
  enrollBrowserVaultQuickUnlock: (...a: unknown[]) => enrollBrowserVaultQuickUnlock(...a),
  unlockBrowserVaultWithQuickSecret: (...a: unknown[]) => unlockBrowserVaultWithQuickSecret(...a),
  removeBrowserVaultQuickUnlock: (...a: unknown[]) => removeBrowserVaultQuickUnlock(...a),
}))

const deriveDevicePepper = jest.fn(async () => new Uint8Array(32).fill(1))
const clearDeviceKey = jest.fn(async () => {})
jest.mock("./device-pepper", () => ({
  deriveDevicePepper: (...a: unknown[]) => deriveDevicePepper(...a),
  clearDeviceKey: (...a: unknown[]) => clearDeviceKey(...a),
}))

import {
  clearQuickUnlockDeviceMaterial,
  enrollQuickUnlock,
  QUICK_UNLOCK_CLEAR_COMMAND,
  QUICK_UNLOCK_CREATE_COMMAND,
  QUICK_UNLOCK_VERIFY_COMMAND,
  removeQuickUnlock,
  verifyQuickUnlock,
} from "./client"

const passwordVerifier: PasswordVerifierRecord = {
  algorithm: "argon2id-v1",
  salt: "c2FsdA",
  hash: "aGFzaA",
  params: {},
}

function enrollment(patch: Partial<QuickUnlockEnrollment> = {}): QuickUnlockEnrollment {
  return {
    method: "pin",
    verifier: { algorithm: "argon2id-quick-v1" },
    createdAt: 0,
    failedAttempts: 0,
    ...patch,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  tauri = false
})

describe("enrollQuickUnlock", () => {
  it("mints a Rust verifier on the desktop host", async () => {
    tauri = true
    invoke.mockResolvedValue({ algorithm: "argon2id-quick-v1", salt: "s", hash: "h" })

    const result = await enrollQuickUnlock({
      accountId: "acct-001",
      method: "pin",
      canonicalSecret: "pin:428193",
      password: "pw",
      passwordVerifier,
      now: 100,
    })

    expect(invoke).toHaveBeenCalledWith(QUICK_UNLOCK_CREATE_COMMAND, {
      accountId: "acct-001",
      method: "pin",
      secret: "pin:428193",
    })
    expect(result.failedAttempts).toBe(0)
    expect(result.createdAt).toBe(100)
    expect(enrollBrowserVaultQuickUnlock).not.toHaveBeenCalled()
  })

  it("never sends the password to the desktop command", async () => {
    // The Rust side has no use for it, and shipping it over IPC would put it
    // somewhere it does not need to be.
    tauri = true
    invoke.mockResolvedValue({})
    await enrollQuickUnlock({
      accountId: "acct-001",
      method: "pin",
      canonicalSecret: "pin:428193",
      password: "hunter2",
      passwordVerifier,
    })
    expect(JSON.stringify(invoke.mock.calls[0][1])).not.toContain("hunter2")
  })

  it("wraps the vault master key in a browser", async () => {
    await enrollQuickUnlock({
      accountId: "acct-001",
      method: "pattern",
      canonicalSecret: "pattern:0-3-4-5-8",
      password: "pw",
      passwordVerifier,
      now: 200,
    })

    expect(enrollBrowserVaultQuickUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "pattern", password: "pw" })
    )
    expect(deriveDevicePepper).toHaveBeenCalledWith("acct-001")
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("verifyQuickUnlock", () => {
  it("opens the account on the desktop host", async () => {
    tauri = true
    invoke.mockResolvedValue(true)

    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: enrollment({ failedAttempts: 2 }),
      canonicalSecret: "pin:428193",
      passwordVerifier,
      now: 500,
    })

    expect(result.ok).toBe(true)
    expect(result.enrollment.failedAttempts).toBe(0)
    expect(result.enrollment.lastUsedAt).toBe(500)
    expect(invoke).toHaveBeenCalledWith(
      QUICK_UNLOCK_VERIFY_COMMAND,
      expect.objectContaining({ passwordVerifier })
    )
  })

  it("counts a wrong secret rather than throwing", async () => {
    // A rejected credential has to update the attempt count. Throwing is how
    // a caller ends up with a catch block that forgets to persist it.
    tauri = true
    invoke.mockResolvedValue(false)

    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: enrollment(),
      canonicalSecret: "pin:000000",
      passwordVerifier,
      now: 500,
    })

    expect(result).toMatchObject({ ok: false, reason: "wrong-secret" })
    expect(result.enrollment.failedAttempts).toBe(1)
  })

  it("treats a failed vault unwrap as a wrong secret", async () => {
    unlockBrowserVaultWithQuickSecret.mockRejectedValueOnce(new Error("decrypt failed"))

    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: enrollment(),
      canonicalSecret: "pin:000000",
      passwordVerifier,
    })

    expect(result).toMatchObject({ ok: false, reason: "wrong-secret" })
    expect(result.enrollment.failedAttempts).toBe(1)
  })

  it("distinguishes a method that is not enrolled from a wrong secret", async () => {
    // Telling a user their PIN is wrong when the real problem is missing
    // device material sends them guessing at a credential that cannot work.
    unlockBrowserVaultWithQuickSecret.mockRejectedValueOnce(
      new Error("That unlock method is not enrolled on this account.")
    )

    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: enrollment(),
      canonicalSecret: "pin:428193",
      passwordVerifier,
    })

    expect(result).toMatchObject({ ok: false, reason: "not-enrolled" })
    // Not a guess, so it does not consume an attempt.
    expect(result.enrollment.failedAttempts).toBe(0)
  })

  it("locks the method out at the cap", async () => {
    tauri = true
    invoke.mockResolvedValue(false)

    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: enrollment({ failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS - 1 }),
      canonicalSecret: "pin:000000",
      passwordVerifier,
      now: 900,
    })

    expect(result.enrollment.failedAttempts).toBe(MAX_QUICK_UNLOCK_ATTEMPTS)
    expect(result.enrollment.lockedOutAt).toBe(900)
  })

  it("refuses a locked-out method without touching either backend", async () => {
    // A locked-out method must cost nothing and reveal nothing.
    tauri = true
    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: enrollment({ failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 }),
      canonicalSecret: "pin:428193",
      passwordVerifier,
    })

    expect(result).toMatchObject({ ok: false, reason: "locked-out" })
    expect(invoke).not.toHaveBeenCalled()
    expect(unlockBrowserVaultWithQuickSecret).not.toHaveBeenCalled()
  })

  it("does not increment past the cap on a locked-out attempt", async () => {
    const locked = enrollment({ failedAttempts: MAX_QUICK_UNLOCK_ATTEMPTS, lockedOutAt: 1 })
    const result = await verifyQuickUnlock({
      accountId: "acct-001",
      enrollment: locked,
      canonicalSecret: "pin:428193",
      passwordVerifier,
    })
    expect(result.enrollment).toBe(locked)
  })
})

describe("removeQuickUnlock", () => {
  it("drops the browser wrap", async () => {
    await removeQuickUnlock("acct-001", "pin")
    expect(removeBrowserVaultQuickUnlock).toHaveBeenCalledWith("acct-001", "pin")
  })

  it("leaves the desktop pepper alone, because it is per account", async () => {
    // Removing one of two methods must not break the other.
    tauri = true
    await removeQuickUnlock("acct-001", "pin")
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("clearQuickUnlockDeviceMaterial", () => {
  it("clears the keyring pepper on the desktop host", async () => {
    tauri = true
    invoke.mockResolvedValue(undefined)
    await clearQuickUnlockDeviceMaterial("acct-001")
    expect(invoke).toHaveBeenCalledWith(QUICK_UNLOCK_CLEAR_COMMAND, { accountId: "acct-001" })
  })

  it("clears the device key in a browser", async () => {
    await clearQuickUnlockDeviceMaterial("acct-001")
    expect(clearDeviceKey).toHaveBeenCalledWith("acct-001")
  })
})
