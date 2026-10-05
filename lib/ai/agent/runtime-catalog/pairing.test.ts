import { hostConfigOriginAgentId, IMPORTED_FROM_AGENT_ID, pairRuntimeConfigs } from "./pairing"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

function hostRecord(
  configId: string,
  name: string | undefined,
  metadata?: Record<string, unknown>
): ExternalAgentConfigRecord {
  return {
    configId,
    revision: `rev_${configId}`,
    lifecycleGeneration: 1,
    seq: 1,
    config: { name, protocol: "pi-rpc", ...(metadata ? { metadata } : {}) },
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 0,
    updatedAt: 0,
  } as ExternalAgentConfigRecord
}

describe("hostConfigOriginAgentId", () => {
  it("reads the recorded origin", () => {
    const record = hostRecord("eac_1", "Pi", { [IMPORTED_FROM_AGENT_ID]: "local_1" })
    expect(hostConfigOriginAgentId(record)).toBe("local_1")
  })

  it("answers null when nothing was recorded, or the value is not a usable id", () => {
    expect(hostConfigOriginAgentId(hostRecord("eac_1", "Pi"))).toBeNull()
    expect(hostConfigOriginAgentId(hostRecord("eac_1", "Pi", {}))).toBeNull()
    expect(
      hostConfigOriginAgentId(hostRecord("eac_1", "Pi", { [IMPORTED_FROM_AGENT_ID]: "" }))
    ).toBeNull()
    expect(
      hostConfigOriginAgentId(hostRecord("eac_1", "Pi", { [IMPORTED_FROM_AGENT_ID]: 7 }))
    ).toBeNull()
  })
})

describe("pairRuntimeConfigs", () => {
  it("pairs on the recorded origin even after both sides were renamed", () => {
    const local = { id: "local_1", name: "Pi, renamed here" }
    const host = hostRecord("eac_1", "Pi, renamed there", {
      [IMPORTED_FROM_AGENT_ID]: "local_1",
    })
    const result = pairRuntimeConfigs([local], [host])
    expect(result.paired).toEqual([{ local, host }])
    expect(result.localOnly).toEqual([])
    expect(result.hostOnly).toEqual([])
  })

  it("falls back to the name for a copy made before provenance was recorded", () => {
    const local = { id: "local_1", name: "Pi (native RPC)" }
    const host = hostRecord("eac_1", "Pi (native RPC)")
    expect(pairRuntimeConfigs([local], [host]).paired).toEqual([{ local, host }])
  })

  it("matches names case-insensitively and ignores surrounding space", () => {
    const local = { id: "local_1", name: "  pi (Native RPC) " }
    const host = hostRecord("eac_1", "Pi (native RPC)")
    expect(pairRuntimeConfigs([local], [host]).paired).toHaveLength(1)
  })

  it("never pairs on a blank or absent name", () => {
    const local = { id: "local_1", name: "   " }
    const host = hostRecord("eac_1", undefined)
    const result = pairRuntimeConfigs([local], [host])
    expect(result.paired).toEqual([])
    expect(result.localOnly).toEqual([local])
    expect(result.hostOnly).toEqual([host])
  })

  it("does not guess between two local agents that share a name", () => {
    // The store mints a fresh id per add and checks no name, so two local
    // agents can genuinely share one. Neither is provably the host's copy, so
    // neither pairs on the name: a wrong guess shows one agent's details on a
    // row that runs the other.
    const first = { id: "local_1", name: "Pi" }
    const second = { id: "local_2", name: "Pi" }
    const host = hostRecord("eac_1", "Pi")
    const result = pairRuntimeConfigs([first, second], [host])
    expect(result.paired).toEqual([])
    expect(result.localOnly).toEqual([first, second])
    expect(result.hostOnly).toEqual([host])
  })

  it("gives one host record to at most one local agent through provenance", () => {
    const first = { id: "local_1", name: "Pi" }
    const second = { id: "local_2", name: "Pi (copy)" }
    const host = hostRecord("eac_1", "Pi", { [IMPORTED_FROM_AGENT_ID]: "local_1" })
    const result = pairRuntimeConfigs([first, second], [host])
    expect(result.paired).toEqual([{ local: first, host }])
    expect(result.localOnly).toEqual([second])
  })

  it("does not guess between two host records that share a name", () => {
    const local = { id: "local_1", name: "Codex" }
    const a = hostRecord("eac_a", "Codex")
    const b = hostRecord("eac_b", "codex ")
    const result = pairRuntimeConfigs([local], [a, b])
    expect(result.paired).toEqual([])
    expect(result.hostOnly).toEqual([a, b])
  })

  it("never claims a record by name when it names a different origin", () => {
    const local = { id: "local_1", name: "Pi" }
    const elsewhere = hostRecord("eac_1", "Pi", { [IMPORTED_FROM_AGENT_ID]: "local_9" })
    const result = pairRuntimeConfigs([local], [elsewhere])
    expect(result.paired).toEqual([])
    expect(result.localOnly).toEqual([local])
  })

  it("prefers provenance over the name when the two disagree", () => {
    const local = { id: "local_2", name: "Pi" }
    const byName = hostRecord("eac_name", "Pi")
    const byOrigin = hostRecord("eac_origin", "Something else", {
      [IMPORTED_FROM_AGENT_ID]: "local_2",
    })
    const result = pairRuntimeConfigs([local], [byName, byOrigin])
    expect(result.paired).toEqual([{ local, host: byOrigin }])
    expect(result.hostOnly).toEqual([byName])
  })

  it("splits everything that pairs with nothing", () => {
    const local = { id: "local_1", name: "Codex" }
    const host = hostRecord("eac_1", "Pi")
    const result = pairRuntimeConfigs([local], [host])
    expect(result.paired).toEqual([])
    expect(result.localOnly).toEqual([local])
    expect(result.hostOnly).toEqual([host])
  })
})
