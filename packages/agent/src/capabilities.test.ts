import * as capabilities from "./capabilities"
import {
  CLIENT_CAPABILITIES,
  hasCapability,
  isVersionedCapability,
  parseCapability,
} from "./capabilities"

const exported = Object.entries(capabilities)
  .filter(([name]) => name.startsWith("CAP_"))
  .map(([, value]) => value as string)

describe("capability identifiers", () => {
  it("exports at least one capability constant", () => {
    expect(exported.length).toBeGreaterThan(0)
  })

  it("versions every capability identifier", () => {
    const unversioned = exported.filter((value) => !isVersionedCapability(value))
    expect(unversioned).toEqual([])
  })

  it("keeps every identifier unique", () => {
    expect(new Set(exported).size).toBe(exported.length)
  })

  it("keeps the sandbox policy claim distinct from a filesystem checkpoint", () => {
    expect(capabilities.CAP_SANDBOX_POLICY_V1).not.toBe(capabilities.CAP_WORKSPACE_CHECKPOINT_V1)
    expect(capabilities.CAP_SANDBOX_POLICY_V1).not.toContain("snapshot")
  })

  it("splits an identifier into name and version", () => {
    expect(parseCapability("event-replay-v2")).toEqual({ name: "event-replay", version: 2 })
    expect(parseCapability("worker-dispatch-v1")).toEqual({ name: "worker-dispatch", version: 1 })
  })

  it("rejects an unversioned or malformed identifier", () => {
    for (const value of ["event-replay", "Event-Replay-v1", "-v1", "mcp-v", "mcp-vx"]) {
      expect(isVersionedCapability(value)).toBe(false)
      expect(parseCapability(value)).toBeUndefined()
    }
  })

  it("does not treat a newer major capability as satisfying an older one", () => {
    expect(hasCapability(["event-replay-v2"], "event-replay-v1")).toBe(false)
    expect(hasCapability(["event-replay-v2"], "event-replay-v2")).toBe(true)
  })

  it("declares only capabilities the client itself implements", () => {
    for (const capability of CLIENT_CAPABILITIES) {
      expect(isVersionedCapability(capability)).toBe(true)
      expect(exported).toContain(capability)
    }
  })
  it("reserves workspace-checkpoint-v1 without any host declaring it", async () => {
    // Deliberately dormant. The identifier exists so that a backend which gains
    // real filesystem checkpointing has one name to claim, and so that nothing
    // is tempted to reuse `sandbox-policy-v1` for it. No host implements it, so
    // no host may declare it — this test is what keeps that true.
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const host = readFileSync(
      join(__dirname, "..", "..", "..", "cli", "src", "agent", "rpc", "runtime-service.ts"),
      "utf8"
    )
    const declaredBlock = /const SERVICE_CAPABILITIES = \[([\s\S]*?)\] as const/.exec(host)
    expect(declaredBlock).not.toBeNull()
    expect(declaredBlock![1]).not.toContain("CAP_WORKSPACE_CHECKPOINT_V1")
    expect(declaredBlock![1]).toContain("CAP_SANDBOX_POLICY_V1")
  })

  it("keeps the sandbox policy record out of checkpoint vocabulary", () => {
    expect(capabilities.CAP_SANDBOX_POLICY_V1).toBe("sandbox-policy-v1")
    expect(capabilities.CAP_WORKSPACE_CHECKPOINT_V1).toBe("workspace-checkpoint-v1")
  })
  it("reserves assets-in-turn-v1 without any host declaring it", async () => {
    // The asset store is real and `assets-v1` is declared. Reading an asset
    // *during a turn* is not implemented, because UnifiedTurnParams has nowhere
    // to put one, so the second capability stays undeclared and the host
    // refuses a turn that carries references rather than dropping them.
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const host = readFileSync(
      join(__dirname, "..", "..", "..", "cli", "src", "agent", "rpc", "runtime-service.ts"),
      "utf8"
    )
    const declared = /const SERVICE_CAPABILITIES = \[([\s\S]*?)\] as const/.exec(host)![1]!
    expect(declared).toContain("CAP_ASSETS_V1")
    expect(declared).not.toContain("CAP_ASSETS_IN_TURN_V1")
  })
})
