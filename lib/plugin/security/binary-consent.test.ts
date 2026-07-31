// Node env (the default for lib/**/*.test.ts). Every Dexie/crypto dep is
// injected, so nothing here needs a DOM — see `binary-hash.test.ts` for why
// real `sha256Bytes` must not run under jsdom.

import {
  confirmBinarySpawn,
  configureBinaryConsent,
  toBinaryConsentOutcome,
  __resetBinaryConsentForTesting,
} from "./binary-consent"
import type { BinaryConsentOutcome } from "./consent-broker"

const BINARY_PATH = "/plugins/acme/bin/tool"
const REL_PATH = "bin/tool"
const SHA = "c".repeat(64)

interface Recorded {
  pluginId: string
  binaryPath: string
  sha256: string
}

function setup(outcome: BinaryConsentOutcome, hash: string | null = SHA) {
  const recorded: Recorded[] = []
  const prompt = jest.fn(async (_input: Record<string, unknown>) => outcome)
  const hashBinary = jest.fn(async (_path: string) => hash)
  const recordApproval = jest.fn(async (row: Recorded) => {
    recorded.push(row)
    return row
  })
  configureBinaryConsent({ prompt, hashBinary, recordApproval })
  return { recorded, prompt, hashBinary, recordApproval }
}

const INPUT = {
  pluginId: "acme",
  permission: "cli:execute" as const,
  binaryPath: BINARY_PATH,
  relPath: REL_PATH,
  reason: "no recorded approval",
}

afterEach(() => {
  __resetBinaryConsentForTesting()
  jest.clearAllMocks()
})

describe("confirmBinarySpawn", () => {
  it("unchecked_consent_stays_session_scoped_and_writes_nothing", async () => {
    // THE regression guard. "Allow once" / "Always allow this session" are both
    // session-scoped: they die on reload. Persisting either into the ledger
    // would silently upgrade a one-run "yes" into a permanent grant — the exact
    // privilege-escalation class the v109 rebuild removed. Consent without the
    // checkbox must reach Dexie never.
    const { recorded, hashBinary, recordApproval } = setup({ granted: true, remember: false })

    const outcome = await confirmBinarySpawn(INPUT)

    expect(outcome).toEqual({ granted: true, remember: false })
    expect(recordApproval).not.toHaveBeenCalled()
    expect(recorded).toEqual([])
    // Not even hashed — there is nothing to pin an approval to.
    expect(hashBinary).not.toHaveBeenCalled()
  })

  it("checked_consent_persists_the_binary_hash", async () => {
    const { recorded, recordApproval } = setup({ granted: true, remember: true })

    const outcome = await confirmBinarySpawn(INPUT)

    expect(outcome).toEqual({ granted: true, remember: true })
    expect(recordApproval).toHaveBeenCalledTimes(1)
    // The row is keyed by (pluginId, binaryPath) and pinned to the bytes —
    // no publisher, no wildcard, no inheritance.
    expect(recorded).toEqual([{ pluginId: "acme", binaryPath: BINARY_PATH, sha256: SHA }])
  })

  it("passes the binary subject to the prompt so the UI can offer the checkbox", async () => {
    const { prompt } = setup({ granted: true, remember: false })
    await confirmBinarySpawn(INPUT)
    expect(prompt).toHaveBeenCalledWith({
      pluginId: "acme",
      permission: "cli:execute",
      reason: "no recorded approval",
      binary: { path: BINARY_PATH, relPath: REL_PATH },
    })
  })

  it("writes nothing when consent is rejected, even if remember somehow came back true", async () => {
    // Defense in depth: a rejection with remember set is incoherent. The broker
    // already strips it; this pins that the writer refuses it too.
    const { recordApproval } = setup({ granted: false, remember: true })
    await expect(confirmBinarySpawn(INPUT)).resolves.toEqual({ granted: false, remember: false })
    expect(recordApproval).not.toHaveBeenCalled()
  })

  it("refuses to record an approval it cannot pin to a hash", async () => {
    // An unverifiable row is worse than none: its hash could never match, so it
    // would prompt forever while looking to the user like a live grant.
    const { recordApproval } = setup({ granted: true, remember: true }, null)
    // The spawn the user just approved still proceeds — only durability is lost.
    await expect(confirmBinarySpawn(INPUT)).resolves.toEqual({ granted: true, remember: false })
    expect(recordApproval).not.toHaveBeenCalled()
  })

  it("reports remember:false when the ledger write fails, without blocking the spawn", async () => {
    setup({ granted: true, remember: true })
    configureBinaryConsent({
      recordApproval: jest.fn(async () => {
        throw new Error("QuotaExceededError")
      }),
    })
    await expect(confirmBinarySpawn(INPUT)).resolves.toEqual({ granted: true, remember: false })
  })
})

describe("toBinaryConsentOutcome", () => {
  it("reads a bare boolean as session-scoped — never as remembered", () => {
    // Backward compatibility for callers typed on the old boolean contract.
    // `true` must mean "granted, this run"; inferring durability from a legacy
    // caller would reintroduce the bug by the back door.
    expect(toBinaryConsentOutcome(true)).toEqual({ granted: true, remember: false })
    expect(toBinaryConsentOutcome(false)).toEqual({ granted: false, remember: false })
  })

  it("passes an outcome object through, coercing missing flags to false", () => {
    expect(toBinaryConsentOutcome({ granted: true, remember: true })).toEqual({
      granted: true,
      remember: true,
    })
    expect(toBinaryConsentOutcome({} as BinaryConsentOutcome)).toEqual({
      granted: false,
      remember: false,
    })
  })
})
