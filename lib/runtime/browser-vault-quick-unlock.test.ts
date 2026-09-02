/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  enrollBrowserVaultQuickUnlock,
  listBrowserVaultQuickUnlockMethods,
  lockBrowserVault,
  getActiveBrowserVault,
  provisionBrowserVault,
  removeBrowserVaultQuickUnlock,
  unlockBrowserVaultWithQuickSecret,
  __resetBrowserVaultForTesting,
  __setBrowserVaultArgon2ParametersForTesting,
} from "./browser-vault"
import { canonicalizePattern, canonicalizePin } from "@/lib/accounts/quick-unlock/secret-policy"

const PASSWORD = "correct horse battery staple"
const PIN = canonicalizePin("428193")
const PATTERN = canonicalizePattern([0, 3, 4, 5, 8])

/** The active session, or a failure that reads as a test error rather than a null deref. */
function requireSession() {
  const session = getActiveBrowserVault()
  if (!session) throw new Error("expected the vault to be unlocked")
  return session
}

function pepper(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed)
}

// Production Argon2 costs 19 MiB per derivation, and this suite performs
// dozens. The cost parameter is not what is under test here, so it is dialled
// down the same way `browser-vault.test.ts` does.
beforeAll(() => {
  __setBrowserVaultArgon2ParametersForTesting(32)
})

let accountSeq = 0
function nextAccount(): string {
  accountSeq += 1
  return `quickacct${accountSeq.toString().padStart(3, "0")}`
}

describe("browser vault quick unlock", () => {
  it("opens the vault with an enrolled PIN", async () => {
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(1),
    })
    lockBrowserVault()

    await unlockBrowserVaultWithQuickSecret({
      accountId,
      method: "pin",
      canonicalSecret: PIN,
      pepper: pepper(1),
    })
    expect(requireSession().isUnlocked()).toBe(true)
  })

  it("unwraps the SAME master key the password unwraps", async () => {
    // The property that makes quick unlock usable at all: content encrypted
    // before enrollment must still decrypt after a PIN unlock.
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    const secret = await requireSession().encryptSecret("token", "s3cret-value")

    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(2),
    })
    lockBrowserVault()
    await unlockBrowserVaultWithQuickSecret({
      accountId,
      method: "pin",
      canonicalSecret: PIN,
      pepper: pepper(2),
    })

    expect(await requireSession().decryptSecret("token", secret)).toBe("s3cret-value")
  })

  it("refuses a wrong PIN", async () => {
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(3),
    })
    lockBrowserVault()

    await expect(
      unlockBrowserVaultWithQuickSecret({
        accountId,
        method: "pin",
        canonicalSecret: canonicalizePin("999999"),
        pepper: pepper(3),
      })
    ).rejects.toThrow()
  })

  it("refuses the right PIN with the wrong device pepper", async () => {
    // This is the whole security argument. A database copied to another
    // machine carries the wrap but not the pepper, so the 20-bit secret cannot
    // be attacked there at all.
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(4),
    })
    lockBrowserVault()

    await expect(
      unlockBrowserVaultWithQuickSecret({
        accountId,
        method: "pin",
        canonicalSecret: PIN,
        pepper: pepper(200),
      })
    ).rejects.toThrow()
  })

  it("refuses to enroll without the current password", async () => {
    // Enrollment mints a new way in, so an unlocked session is not enough.
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await expect(
      enrollBrowserVaultQuickUnlock({
        accountId,
        method: "pin",
        password: "not the password",
        canonicalSecret: PIN,
        pepper: pepper(5),
      })
    ).rejects.toThrow()
  })

  it("keeps methods in separate AAD domains", async () => {
    // A pattern wrap must not be openable by presenting its bytes as a PIN.
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pattern",
      password: PASSWORD,
      canonicalSecret: PATTERN,
      pepper: pepper(6),
    })
    lockBrowserVault()

    await expect(
      unlockBrowserVaultWithQuickSecret({
        accountId,
        method: "pin",
        canonicalSecret: PATTERN,
        pepper: pepper(6),
      })
    ).rejects.toThrow(/not enrolled/i)
  })

  it("supports several methods on one account at once", async () => {
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(7),
    })
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pattern",
      password: PASSWORD,
      canonicalSecret: PATTERN,
      pepper: pepper(7),
    })

    expect((await listBrowserVaultQuickUnlockMethods(accountId)).sort()).toEqual(["pattern", "pin"])

    lockBrowserVault()
    await unlockBrowserVaultWithQuickSecret({
      accountId,
      method: "pattern",
      canonicalSecret: PATTERN,
      pepper: pepper(7),
    })
    expect(requireSession().isUnlocked()).toBe(true)
  })

  it("removes one method without disturbing the others", async () => {
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(8),
    })
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pattern",
      password: PASSWORD,
      canonicalSecret: PATTERN,
      pepper: pepper(8),
    })

    await removeBrowserVaultQuickUnlock(accountId, "pin")
    expect(await listBrowserVaultQuickUnlockMethods(accountId)).toEqual(["pattern"])

    lockBrowserVault()
    await expect(
      unlockBrowserVaultWithQuickSecret({
        accountId,
        method: "pin",
        canonicalSecret: PIN,
        pepper: pepper(8),
      })
    ).rejects.toThrow(/not enrolled/i)
  })

  it("reports a method that was never enrolled", async () => {
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    lockBrowserVault()
    await expect(
      unlockBrowserVaultWithQuickSecret({
        accountId,
        method: "passkey",
        canonicalSecret: "whatever",
        pepper: pepper(9),
      })
    ).rejects.toThrow(/not enrolled/i)
  })

  it("leaves the password path working after enrollment", async () => {
    // Quick unlock is additive. Enrolling one must never disturb the factor
    // that is the only one able to stand alone.
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await enrollBrowserVaultQuickUnlock({
      accountId,
      method: "pin",
      password: PASSWORD,
      canonicalSecret: PIN,
      pepper: pepper(10),
    })
    lockBrowserVault()

    const { unlockBrowserVault } = await import("./browser-vault")
    await expect(unlockBrowserVault(accountId, PASSWORD)).resolves.toBeUndefined()
  })

  it("removing a method that was never enrolled is a no-op", async () => {
    const accountId = nextAccount()
    await provisionBrowserVault(accountId, PASSWORD)
    await expect(removeBrowserVaultQuickUnlock(accountId, "pin")).resolves.toBeUndefined()
  })
})

afterAll(() => {
  __resetBrowserVaultForTesting()
})
