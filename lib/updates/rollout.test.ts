import {
  ROLLOUT_BUCKET_COUNT,
  eligibleCandidates,
  generateRolloutBucket,
  normalizeRolloutBucket,
  rolloutVerdict,
} from "./rollout"
import type { UpdateCandidate } from "@cognia/agent-config-types"

function candidate(overrides: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    currentVersion: "1.0.0",
    targetVersion: "1.1.0",
    channel: "stable",
    criticality: "routine",
    source: "catalog",
    provenance: "verified",
    ...overrides,
  }
}

describe("bucket generation", () => {
  it("stays inside the bucket range", () => {
    for (let i = 0; i < 50; i += 1) {
      const bucket = generateRolloutBucket()
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(ROLLOUT_BUCKET_COUNT)
    }
  })

  it("keeps a valid persisted bucket unchanged", () => {
    expect(normalizeRolloutBucket(4321)).toBe(4321)
  })

  it("regenerates anything out of range or malformed", () => {
    expect(normalizeRolloutBucket(-1, () => 0.5)).toBeLessThan(ROLLOUT_BUCKET_COUNT)
    expect(normalizeRolloutBucket("nope", () => 0.5)).toBeLessThan(ROLLOUT_BUCKET_COUNT)
    expect(normalizeRolloutBucket(ROLLOUT_BUCKET_COUNT, () => 0.5)).toBeLessThan(
      ROLLOUT_BUCKET_COUNT
    )
  })
})

describe("rolloutVerdict", () => {
  it("offers a candidate with no rollout window at all", () => {
    expect(rolloutVerdict(undefined, 9999)).toBe("offered")
  })

  it("offers only the buckets inside the percentage", () => {
    expect(rolloutVerdict({ percentage: 10 }, 999)).toBe("offered")
    expect(rolloutVerdict({ percentage: 10 }, 1000)).toBe("not-yet")
  })

  it("lets a manual check jump the percentage queue", () => {
    expect(rolloutVerdict({ percentage: 1 }, 9999, { manual: true })).toBe("offered")
  })

  it("does not let a manual check bypass a pause", () => {
    expect(rolloutVerdict({ percentage: 100, paused: true }, 0, { manual: true })).toBe("paused")
  })

  it("does not let a manual check bypass a revocation", () => {
    expect(rolloutVerdict({ percentage: 100, revoked: true }, 0, { manual: true })).toBe("revoked")
  })

  it("ranks revocation above a pause", () => {
    expect(rolloutVerdict({ percentage: 100, paused: true, revoked: true }, 0)).toBe("revoked")
  })
})

describe("eligibleCandidates", () => {
  it("keeps only what this device may install", () => {
    const list = [
      candidate({ assetId: "a", rollout: { percentage: 100 } }),
      candidate({ assetId: "b", rollout: { percentage: 1 } }),
      candidate({ assetId: "c", rollout: { percentage: 100, revoked: true } }),
    ]
    expect(eligibleCandidates(list, 5000).map((c) => c.assetId)).toEqual(["a"])
  })
})
