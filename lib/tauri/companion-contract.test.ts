import { COMPANION_CONTRACT_VERSION } from "./command-descriptors"
import {
  __resetHostContractsForTests,
  contractIncompatibleError,
  forgetHostContract,
  hostContractVerdict,
  judgeHostContract,
  onHostContractChange,
  recordHostContract,
} from "./companion-contract"

describe("companion contract verdict (ADR-0175)", () => {
  afterEach(() => __resetHostContractsForTests())

  it("is compatible only when the Host names exactly this client's contract version", () => {
    expect(
      judgeHostContract({ contractVersion: COMPANION_CONTRACT_VERSION, catalogHash: "abc" })
    ).toEqual({
      state: "compatible",
      contractVersion: COMPANION_CONTRACT_VERSION,
      catalogHash: "abc",
    })
    expect(judgeHostContract({ contractVersion: COMPANION_CONTRACT_VERSION })).toMatchObject({
      state: "compatible",
      catalogHash: null,
    })
    expect(judgeHostContract({ contractVersion: COMPANION_CONTRACT_VERSION + 1 })).toEqual({
      state: "incompatible",
      hostContractVersion: COMPANION_CONTRACT_VERSION + 1,
      clientContractVersion: COMPANION_CONTRACT_VERSION,
    })
  })

  it("treats a Host that names no version, or a malformed one, as an older, incompatible Host", () => {
    for (const identity of [
      undefined,
      null,
      {},
      { contractVersion: "3" },
      { contractVersion: 3.5 },
    ]) {
      expect(judgeHostContract(identity)).toEqual({
        state: "incompatible",
        hostContractVersion: null,
        clientContractVersion: COMPANION_CONTRACT_VERSION,
      })
    }
  })

  it("is unknown until a handshake answers, then remembers per pairing", () => {
    expect(hostContractVerdict("device-a")).toEqual({ state: "unknown" })
    recordHostContract("device-a", { contractVersion: COMPANION_CONTRACT_VERSION })
    recordHostContract("device-b", { contractVersion: 1 })
    expect(hostContractVerdict("device-a").state).toBe("compatible")
    expect(hostContractVerdict("device-b")).toMatchObject({
      state: "incompatible",
      hostContractVersion: 1,
    })
    forgetHostContract("device-b")
    expect(hostContractVerdict("device-b")).toEqual({ state: "unknown" })
  })

  it("notifies listeners on a change of verdict, not on a repeat of the same one", () => {
    const seen: string[] = []
    const off = onHostContractChange((deviceId, verdict) =>
      seen.push(`${deviceId}:${verdict.state}`)
    )
    recordHostContract("device-a", { contractVersion: COMPANION_CONTRACT_VERSION })
    recordHostContract("device-a", { contractVersion: COMPANION_CONTRACT_VERSION })
    recordHostContract("device-a", { contractVersion: 2 })
    forgetHostContract("device-a")
    off()
    recordHostContract("device-a", { contractVersion: 2 })
    expect(seen).toEqual(["device-a:compatible", "device-a:incompatible", "device-a:unknown"])
  })

  it("names both versions in the refusal and never invites a retry", () => {
    const error = contractIncompatibleError({
      state: "incompatible",
      hostContractVersion: 2,
      clientContractVersion: 3,
    })
    expect(error.code).toBe("contract_incompatible")
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("v2")
    expect(error.message).toContain("v3")
    expect(
      contractIncompatibleError({
        state: "incompatible",
        hostContractVersion: null,
        clientContractVersion: 3,
      }).message
    ).toContain("names no command contract version")
  })
})
