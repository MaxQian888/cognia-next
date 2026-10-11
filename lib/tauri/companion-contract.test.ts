import { COMPANION_CONTRACT_VERSION, getCommandDescriptor } from "./command-descriptors"
import {
  VERSION_INDEPENDENT_COMMANDS,
  __resetHostContractsForTests,
  contractIncompatibleError,
  forgetHostContract,
  hostContractVerdict,
  isVersionIndependentCommand,
  judgeHostContract,
  onHostBrainChange,
  onHostContractChange,
  parseHostBrainRefusal,
  recordHostBrain,
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

  describe("a Host's refused brain (ADR-0224 A10)", () => {
    const refusal = {
      reason: "contract_mismatch",
      atMs: 1,
      brain: { version: "0.2.0", protocol: 3, contractVersion: 4, catalogHash: "b" },
      server: { version: "0.1.0", protocol: 3, contractVersion: 3, catalogHash: "s" },
    }

    it("reads both sides of the mismatch and nothing malformed", () => {
      expect(parseHostBrainRefusal(refusal)).toEqual({
        reason: "contract_mismatch",
        brain: { version: "0.2.0", contractVersion: 4 },
        server: { version: "0.1.0", contractVersion: 3 },
      })
      expect(parseHostBrainRefusal(undefined)).toBeNull()
      expect(parseHostBrainRefusal({ reason: "x" })).toBeNull()
      expect(parseHostBrainRefusal({ ...refusal, reason: 7 })).toBeNull()
    })

    it("tells listeners when a refusal appears and when it clears, once each", () => {
      const seen: unknown[] = []
      onHostBrainChange((deviceId, value) => seen.push([deviceId, value?.reason ?? null]))
      recordHostBrain("dev-1", undefined)
      recordHostBrain("dev-1", refusal)
      recordHostBrain("dev-1", refusal)
      recordHostBrain("dev-1", undefined)
      expect(seen).toEqual([
        ["dev-1", null],
        ["dev-1", "contract_mismatch"],
        ["dev-1", null],
      ])
    })
  })
})

describe("version-independent commands (ADR-0224 A10)", () => {
  it("are only the Host's own owner-gated update commands", () => {
    expect([...VERSION_INDEPENDENT_COMMANDS].sort()).toEqual([
      "host_update_configure",
      "host_update_install",
      "host_update_refresh",
      "host_update_status",
    ])
    for (const name of VERSION_INDEPENDENT_COMMANDS) {
      expect(getCommandDescriptor(name)).toMatchObject({
        target: "host-admin",
        capability: "host.admin",
      })
    }
    expect(isVersionIndependentCommand("host_update_install")).toBe(true)
    expect(isVersionIndependentCommand("claude_sidecar_status")).toBe(false)
  })
})
