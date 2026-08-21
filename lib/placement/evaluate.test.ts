import { evaluatePlacement } from "./evaluate"
import type { PlacementCandidate, PlacementRequirement } from "./types"

const NOW = 1_000_000

function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    ref: "device:a",
    kind: "worker",
    liveness: { online: true, lastSeenAt: NOW, source: "socket" },
    provides: [
      { dimension: "agent", value: "streaming" },
      { dimension: "workspace", value: "repository:p:r" },
      { dimension: "sandbox", value: "filesystem" },
      { dimension: "credential", value: "credential:test" },
    ],
    activeUnits: 0,
    maxUnits: 2,
    ...overrides,
  }
}

const need = (dimension: PlacementRequirement["dimension"], value: string) => ({
  dimension,
  value,
})

describe("evaluatePlacement", () => {
  it("accepts a live candidate that provides everything and has room", () => {
    expect(evaluatePlacement(candidate(), [need("agent", "streaming")], NOW)).toEqual({
      ready: true,
    })
  })

  it("reports offline before anything else", () => {
    // A candidate that is both offline and incompatible should say "offline" —
    // that is the condition a human can act on.
    const verdict = evaluatePlacement(
      candidate({ liveness: { online: false, lastSeenAt: NOW, source: "socket" }, provides: [] }),
      [need("agent", "streaming")],
      NOW
    )
    expect(verdict).toEqual({ ready: false, reason: "offline" })
  })

  it("names the rejection after the dimension that failed", () => {
    // "Missing a workspace binding" and "missing a sandbox feature" need
    // different fixes; one generic mismatch would make the reason useless.
    const bare = candidate({ provides: [] })
    expect(evaluatePlacement(bare, [need("workspace", "repository:p:r")], NOW)).toMatchObject({
      reason: "workspace_missing",
    })
    expect(evaluatePlacement(bare, [need("credential", "credential:x")], NOW)).toMatchObject({
      reason: "credential_missing",
    })
    expect(evaluatePlacement(bare, [need("sandbox", "filesystem")], NOW)).toMatchObject({
      reason: "sandbox_mismatch",
    })
    expect(evaluatePlacement(bare, [need("agent", "tools")], NOW)).toMatchObject({
      reason: "capability_mismatch",
    })
    expect(evaluatePlacement(bare, [need("platform", "camera")], NOW)).toMatchObject({
      reason: "capability_mismatch",
    })
  })

  it("returns exactly what was missing", () => {
    const verdict = evaluatePlacement(
      candidate({ provides: [{ dimension: "agent", value: "streaming" }] }),
      [need("agent", "streaming"), need("agent", "tools")],
      NOW
    )
    expect(verdict).toMatchObject({ missing: [{ dimension: "agent", value: "tools" }] })
  })

  it("never matches the same value across two vocabularies", () => {
    // `CapabilityId` and `AgentCapabilityId` are different value spaces owned by
    // different modules. A platform "streaming" must not satisfy an agent
    // "streaming" just because the strings happen to coincide.
    const platformOnly = candidate({
      provides: [{ dimension: "platform", value: "streaming" }],
    })
    expect(evaluatePlacement(platformOnly, [need("agent", "streaming")], NOW)).toMatchObject({
      ready: false,
    })
  })

  it("reports capacity only once every requirement is satisfied", () => {
    const full = candidate({ activeUnits: 2, maxUnits: 2 })
    expect(evaluatePlacement(full, [need("agent", "streaming")], NOW)).toEqual({
      ready: false,
      reason: "capacity_exhausted",
    })
    // Incompatible AND full still reports the compatibility problem: raising
    // capacity would not help.
    expect(
      evaluatePlacement(
        candidate({ activeUnits: 2, maxUnits: 2, provides: [] }),
        [need("agent", "streaming")],
        NOW
      )
    ).toMatchObject({ reason: "capability_mismatch" })
  })

  it("treats an uncapped candidate as always having room", () => {
    expect(
      evaluatePlacement(
        candidate({ activeUnits: 999, maxUnits: Number.POSITIVE_INFINITY }),
        [],
        NOW
      )
    ).toEqual({ ready: true })
  })

  it("applies the liveness TTL to timestamp-based candidates", () => {
    const phone = candidate({
      kind: "paired-device",
      liveness: { online: true, lastSeenAt: NOW - 200_000, source: "request" },
    })
    expect(evaluatePlacement(phone, [], NOW)).toEqual({ ready: false, reason: "offline" })
    expect(evaluatePlacement(phone, [], NOW, { ttlMs: 300_000 })).toEqual({ ready: true })
  })
})
