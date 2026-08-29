/** @jest-environment jsdom */

import {
  describeCompanionCredentialDiagnosis,
  diagnoseCompanionCredential,
  type CompanionCredentialAvailability,
} from "./credential-availability"
import type { CompanionCredentialBook, CompanionHostRecord } from "./credential-book"
import { BrowserVaultLockedError } from "./credential-book"

const CONTEXT = { accountId: "acct-a", targetId: "host-a" }

const RECORD = { hostId: "host-a", accountNamespace: "acct-a" } as unknown as CompanionHostRecord

function book(overrides: Partial<CompanionCredentialBook>): CompanionCredentialBook {
  return {
    get: async () => null,
    loadCredential: async () => null,
    ...overrides,
  } as unknown as CompanionCredentialBook
}

describe("diagnoseCompanionCredential", () => {
  it("reports no active account when nothing has selected a runtime target", async () => {
    const diagnosis = await diagnoseCompanionCredential({
      book: book({}),
      activeContext: () => null,
    })
    expect(diagnosis).toEqual({ reason: "no-active-account" })
  })

  it("reports an unpaired client when the active target has no Host record", async () => {
    const diagnosis = await diagnoseCompanionCredential({
      book: book({ get: async () => null }),
      activeContext: () => CONTEXT,
    })
    expect(diagnosis).toMatchObject({
      reason: "no-host-record",
      hostId: "host-a",
      accountNamespace: "acct-a",
    })
  })

  it("separates a locked Vault from an unpaired client", async () => {
    // This is the whole point: `load()` answers null for both, and the two
    // remedies — unlock, and pair — have nothing to do with each other.
    const diagnosis = await diagnoseCompanionCredential({
      book: book({
        get: async () => RECORD,
        loadCredential: async () => {
          throw new BrowserVaultLockedError()
        },
      }),
      activeContext: () => CONTEXT,
    })
    expect(diagnosis.reason).toBe("vault-locked")
  })

  it("separates a half-written pairing from a locked one", async () => {
    const diagnosis = await diagnoseCompanionCredential({
      book: book({ get: async () => RECORD, loadCredential: async () => null }),
      activeContext: () => CONTEXT,
    })
    expect(diagnosis.reason).toBe("no-credential")
  })

  it("reports the credential as readable when the null was transient", async () => {
    const diagnosis = await diagnoseCompanionCredential({
      book: book({
        get: async () => RECORD,
        loadCredential: async () => ({ deviceId: "d" }) as never,
      }),
      activeContext: () => CONTEXT,
    })
    expect(diagnosis.reason).toBe("available")
  })

  it("keeps an unreadable book distinct from an absent record", async () => {
    const diagnosis = await diagnoseCompanionCredential({
      book: book({
        get: async () => {
          throw new Error("dexie is closed")
        },
      }),
      activeContext: () => CONTEXT,
    })
    expect(diagnosis).toMatchObject({ reason: "storage-error", error: "dexie is closed" })
  })

  it("does not misreport a corrupt credential as a locked Vault", async () => {
    const diagnosis = await diagnoseCompanionCredential({
      book: book({
        get: async () => RECORD,
        loadCredential: async () => {
          throw new Error("credential JWK is invalid")
        },
      }),
      activeContext: () => CONTEXT,
    })
    expect(diagnosis).toMatchObject({
      reason: "storage-error",
      error: "credential JWK is invalid",
    })
  })
})

describe("describeCompanionCredentialDiagnosis", () => {
  const REASONS: CompanionCredentialAvailability[] = [
    "available",
    "no-active-account",
    "no-host-record",
    "vault-locked",
    "no-credential",
    "storage-error",
  ]

  it.each(REASONS)("says something specific for %s", (reason) => {
    const text = describeCompanionCredentialDiagnosis({
      reason,
      hostId: "host-a",
      accountNamespace: "acct-a",
    })
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain("undefined")
  })

  it("gives every reason its own sentence", () => {
    const texts = REASONS.map((reason) =>
      describeCompanionCredentialDiagnosis({ reason, hostId: "h", accountNamespace: "a" })
    )
    expect(new Set(texts).size).toBe(REASONS.length)
  })

  it("names the host and account so a report can be matched to a device", () => {
    expect(
      describeCompanionCredentialDiagnosis({
        reason: "vault-locked",
        hostId: "host-a",
        accountNamespace: "acct-a",
      })
    ).toContain("host host-a")
  })

  it("omits the parenthetical when there was no host to name", () => {
    expect(describeCompanionCredentialDiagnosis({ reason: "no-active-account" })).not.toContain("(")
  })
})
