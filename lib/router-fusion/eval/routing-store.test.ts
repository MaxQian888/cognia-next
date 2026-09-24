/**
 * routing-store — routing samples, sealed predictor manifests and shadow
 * decisions in the fusion database (fake-indexeddb).
 */

import "fake-indexeddb/auto"

import { FusionDB } from "../db/fusion-db"
import { ROUTING_SAMPLE_TTL_MS } from "../db/retention"
import type { FusionRoutingSampleRow, FusionShadowDecisionRow } from "../db/types"
import { ROUTING_FEATURES_VERSION } from "./routing-sample"
import {
  activatePredictorManifest,
  activePredictorManifest,
  countRoutingSamples,
  deactivatePredictor,
  getPredictorManifest,
  listPredictorManifests,
  listRoutingSamples,
  listShadowDecisions,
  MANIFEST_HISTORY_CAP,
  putRoutingSamples,
  putShadowDecisions,
  rollbackPredictorManifest,
  routingSampleExpiry,
  RoutingRegistryError,
  sealPredictorManifest,
  type SealManifestInput,
} from "./routing-store"

const NOW = 1_800_000_000_000
let dbCounter = 0
let db: FusionDB

beforeEach(() => {
  db = new FusionDB(`fusion-routing-store-test-${++dbCounter}`)
})

afterEach(async () => {
  db.close()
  await db.delete()
})

function sample(sampleId: string, overrides: Partial<FusionRoutingSampleRow> = {}) {
  const row: FusionRoutingSampleRow = {
    sampleId,
    runId: `run-${sampleId}`,
    groupId: `group-${sampleId}`,
    actionId: "direct_economy",
    actionHash: "hash-direct",
    mode: "direct",
    ruleId: null,
    baselineActionId: "direct_economy",
    featuresVersion: ROUTING_FEATURES_VERSION,
    features: [1, 0, 0.5],
    propensity: 1,
    origin: "recorded",
    costMicrousd: 1_000,
    costStatus: "actual",
    accepted: true,
    qualityStatus: "accepted",
    runStatus: "succeeded",
    decidedAt: NOW,
    createdAt: NOW,
    expiresAt: NOW + ROUTING_SAMPLE_TTL_MS,
    ...overrides,
  }
  return row
}

function sealInput(manifestSha256: string, overrides: Partial<SealManifestInput> = {}) {
  const input: SealManifestInput = {
    manifestSha256,
    kind: "published",
    featuresVersion: ROUTING_FEATURES_VERSION,
    manifest: { sha256: manifestSha256, heads: [] },
    label: "live",
    gateVerdict: "pass",
    gateReasons: [],
    now: NOW,
    ...overrides,
  }
  return input
}

function shadow(shadowId: string, overrides: Partial<FusionShadowDecisionRow> = {}) {
  const row: FusionShadowDecisionRow = {
    shadowId,
    sampleId: `sample-${shadowId}`,
    runId: `run-${shadowId}`,
    manifestSha256: "sha-a",
    predictorVersion: "logistic-platt-1@sha-a",
    actualActionId: "direct_economy",
    shadowActionId: "panel_review",
    shadowPPass: 0.8,
    actualPPass: 0.6,
    agreed: false,
    inDistribution: true,
    createdAt: NOW,
    expiresAt: NOW + ROUTING_SAMPLE_TTL_MS,
    ...overrides,
  }
  return row
}

async function activeShas(): Promise<string[]> {
  const rows = await db.fusionPredictorManifests.toArray()
  return rows.filter((row) => row.active === 1).map((row) => row.manifestSha256)
}

describe("routingSampleExpiry", () => {
  it("puts a sample collected now at the end of the routing-sample window", () => {
    expect(routingSampleExpiry(NOW)).toBe(NOW + ROUTING_SAMPLE_TTL_MS)
    expect(ROUTING_SAMPLE_TTL_MS).toBeGreaterThan(0)
  })
})

describe("RoutingRegistryError", () => {
  it("is an Error carrying a machine-readable code", () => {
    const error = new RoutingRegistryError("NO_ACTIVE_MANIFEST", "nothing active")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("RoutingRegistryError")
    expect(error.code).toBe("NO_ACTIVE_MANIFEST")
    expect(error.message).toBe("nothing active")
  })
})

describe("routing samples", () => {
  it("writes nothing for an empty batch", async () => {
    await expect(putRoutingSamples(db, [])).resolves.toBe(0)
    await expect(countRoutingSamples(db)).resolves.toBe(0)
  })

  it("is idempotent on sampleId: a second write rewrites the row", async () => {
    await expect(putRoutingSamples(db, [sample("a"), sample("b")])).resolves.toBe(2)
    await expect(putRoutingSamples(db, [sample("a", { costMicrousd: 9_999 })])).resolves.toBe(1)
    await expect(countRoutingSamples(db)).resolves.toBe(2)
    const [first] = await listRoutingSamples(db)
    expect(first.sampleId).toBe("a")
    expect(first.costMicrousd).toBe(9_999)
  })

  it("lists in sampleId order whatever the write order", async () => {
    await putRoutingSamples(db, [
      sample("c", { decidedAt: NOW - 3 }),
      sample("a", { decidedAt: NOW - 1 }),
      sample("b", { decidedAt: NOW - 2 }),
    ])
    const rows = await listRoutingSamples(db)
    expect(rows.map((row) => row.sampleId)).toEqual(["a", "b", "c"])
  })

  it("filters by decision time (inclusive), encoding and origin, then limits", async () => {
    await putRoutingSamples(db, [
      sample("a", { decidedAt: NOW - 100 }),
      sample("b", { decidedAt: NOW }),
      sample("c", { decidedAt: NOW + 100, origin: "simulated" }),
      sample("d", { decidedAt: NOW + 200, featuresVersion: "legacy/0" }),
      sample("e", { decidedAt: NOW + 300 }),
    ])
    const ids = async (options: Parameters<typeof listRoutingSamples>[1]) =>
      (await listRoutingSamples(db, options)).map((row) => row.sampleId)

    expect(await ids({ since: NOW })).toEqual(["b", "c", "d", "e"])
    expect(await ids({ featuresVersion: ROUTING_FEATURES_VERSION })).toEqual(["a", "b", "c", "e"])
    expect(await ids({ featuresVersion: "legacy/0" })).toEqual(["d"])
    expect(await ids({ origin: "simulated" })).toEqual(["c"])
    expect(await ids({ origin: "recorded" })).toEqual(["a", "b", "d", "e"])
    expect(
      await ids({ since: NOW, origin: "recorded", featuresVersion: ROUTING_FEATURES_VERSION })
    ).toEqual(["b", "e"])
    expect(await ids({ limit: 2 })).toEqual(["a", "b"])
    expect(await ids({ since: NOW + 150, limit: 1 })).toEqual(["d"])
    expect(await ids({ limit: 0 })).toEqual([])
    expect(await ids({ since: NOW + 1_000 })).toEqual([])
  })
})

describe("sealPredictorManifest", () => {
  it("records a new manifest inactive, with no rollback target", async () => {
    const row = await sealPredictorManifest(
      db,
      sealInput("sha-a", { gateVerdict: "inconclusive", gateReasons: ["INSUFFICIENT_GROUPS"] })
    )
    expect(row).toEqual({
      manifestSha256: "sha-a",
      kind: "published",
      active: 0,
      featuresVersion: ROUTING_FEATURES_VERSION,
      manifest: { sha256: "sha-a", heads: [] },
      previousManifestSha256: null,
      gateVerdict: "inconclusive",
      gateReasons: ["INSUFFICIENT_GROUPS"],
      label: "live",
      activatedAt: null,
      deactivatedAt: null,
      createdAt: NOW,
    })
    await expect(getPredictorManifest(db, "sha-a")).resolves.toEqual(row)
    await expect(activePredictorManifest(db)).resolves.toBeUndefined()
  })

  it("copies the gate reasons instead of keeping the caller's array", async () => {
    const reasons = ["COST_NOT_REDUCED"]
    const row = await sealPredictorManifest(db, sealInput("sha-a", { gateReasons: reasons }))
    reasons.push("mutated")
    expect(row.gateReasons).toEqual(["COST_NOT_REDUCED"])
    expect((await getPredictorManifest(db, "sha-a"))?.gateReasons).toEqual(["COST_NOT_REDUCED"])
  })

  it("re-sealing updates the verdict but keeps activation, rollback target and creation time", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await activatePredictorManifest(db, "sha-a", { now: NOW + 10 })
    await activatePredictorManifest(db, "sha-b", { now: NOW + 20 })

    const resealed = await sealPredictorManifest(
      db,
      sealInput("sha-b", {
        now: NOW + 99,
        gateVerdict: "fail",
        gateReasons: ["PASS_RATE_BELOW_MARGIN"],
        label: "simulated",
        manifest: { resealed: true },
      })
    )
    expect(resealed).toMatchObject({
      manifestSha256: "sha-b",
      active: 1,
      previousManifestSha256: "sha-a",
      activatedAt: NOW + 20,
      deactivatedAt: null,
      createdAt: NOW,
      gateVerdict: "fail",
      gateReasons: ["PASS_RATE_BELOW_MARGIN"],
      label: "simulated",
      manifest: { resealed: true },
    })

    const oldRow = await sealPredictorManifest(db, sealInput("sha-a", { now: NOW + 99 }))
    expect(oldRow.active).toBe(0)
    expect(oldRow.deactivatedAt).toBe(NOW + 20)
    expect(await activeShas()).toEqual(["sha-b"])
  })

  it(`keeps only the ${MANIFEST_HISTORY_CAP} most recent manifests when nothing is active`, async () => {
    const total = MANIFEST_HISTORY_CAP + 3
    for (let index = 0; index < total; index += 1) {
      await sealPredictorManifest(
        db,
        sealInput(`sha-${String(index).padStart(2, "0")}`, { now: NOW + index })
      )
    }
    const kept = await listPredictorManifests(db)
    expect(kept).toHaveLength(MANIFEST_HISTORY_CAP)
    expect(kept.map((row) => row.manifestSha256)).toEqual(
      Array.from(
        { length: MANIFEST_HISTORY_CAP },
        (_, offset) => `sha-${String(total - 1 - offset).padStart(2, "0")}`
      )
    )
    await expect(getPredictorManifest(db, "sha-00")).resolves.toBeUndefined()
  })

  it("never reaps the active manifest or its rollback target, however old", async () => {
    await sealPredictorManifest(db, sealInput("sha-old-a", { now: NOW - 2_000 }))
    await sealPredictorManifest(db, sealInput("sha-old-b", { now: NOW - 1_000 }))
    await activatePredictorManifest(db, "sha-old-a", { now: NOW })
    await activatePredictorManifest(db, "sha-old-b", { now: NOW })
    for (let index = 0; index < MANIFEST_HISTORY_CAP + 2; index += 1) {
      await sealPredictorManifest(
        db,
        sealInput(`sha-new-${String(index).padStart(2, "0")}`, { now: NOW + index })
      )
    }
    const kept = (await listPredictorManifests(db)).map((row) => row.manifestSha256)
    expect(kept).toHaveLength(MANIFEST_HISTORY_CAP + 2)
    expect(kept).toContain("sha-old-a")
    expect(kept).toContain("sha-old-b")
    expect(kept).not.toContain("sha-new-00")
    expect(kept).not.toContain("sha-new-01")
    expect((await activePredictorManifest(db))?.manifestSha256).toBe("sha-old-b")
  })

  it("breaks a creation-time tie by manifest hash when capping", async () => {
    for (let index = MANIFEST_HISTORY_CAP; index >= 0; index -= 1) {
      await sealPredictorManifest(db, sealInput(`sha-${String(index).padStart(2, "0")}`))
    }
    const kept = (await listPredictorManifests(db)).map((row) => row.manifestSha256)
    expect(kept).toHaveLength(MANIFEST_HISTORY_CAP)
    // Same createdAt everywhere: the lexicographically largest hash falls out.
    expect(kept).not.toContain(`sha-${String(MANIFEST_HISTORY_CAP).padStart(2, "0")}`)
    expect(kept[0]).toBe("sha-00")
  })
})

describe("activatePredictorManifest", () => {
  it("refuses an unknown manifest", async () => {
    const attempt = activatePredictorManifest(db, "sha-missing", { now: NOW })
    await expect(attempt).rejects.toBeInstanceOf(RoutingRegistryError)
    await expect(activatePredictorManifest(db, "sha-missing", { now: NOW })).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
      message: expect.stringContaining("sha-missing"),
    })
  })

  it("refuses a training manifest", async () => {
    await sealPredictorManifest(db, sealInput("sha-train", { kind: "training", gateVerdict: null }))
    await expect(activatePredictorManifest(db, "sha-train", { now: NOW })).rejects.toMatchObject({
      code: "NOT_PUBLISHED",
    })
    expect(await activeShas()).toEqual([])
  })

  it("refuses a manifest of another feature encoding when the build names its own", async () => {
    await sealPredictorManifest(db, sealInput("sha-old", { featuresVersion: "legacy/0" }))
    await expect(
      activatePredictorManifest(db, "sha-old", {
        now: NOW,
        expectedFeaturesVersion: ROUTING_FEATURES_VERSION,
      })
    ).rejects.toMatchObject({
      code: "FEATURES_VERSION_MISMATCH",
      message: `manifest encodes legacy/0, this build encodes ${ROUTING_FEATURES_VERSION}`,
    })
    // Without an expectation the version is not checked.
    await expect(activatePredictorManifest(db, "sha-old", { now: NOW })).resolves.toMatchObject({
      active: 1,
    })
  })

  it("activates the first manifest with no rollback target", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    const activated = await activatePredictorManifest(db, "sha-a", {
      now: NOW + 5,
      expectedFeaturesVersion: ROUTING_FEATURES_VERSION,
    })
    expect(activated).toMatchObject({
      manifestSha256: "sha-a",
      active: 1,
      previousManifestSha256: null,
      activatedAt: NOW + 5,
      deactivatedAt: null,
    })
    await expect(activePredictorManifest(db)).resolves.toEqual(activated)
  })

  it("moves the pointer: the replaced manifest is deactivated and becomes the rollback target", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await activatePredictorManifest(db, "sha-a", { now: NOW + 1 })
    const activated = await activatePredictorManifest(db, "sha-b", { now: NOW + 2 })

    expect(activated.previousManifestSha256).toBe("sha-a")
    expect(await activeShas()).toEqual(["sha-b"])
    const replaced = await getPredictorManifest(db, "sha-a")
    expect(replaced).toMatchObject({ active: 0, deactivatedAt: NOW + 2, activatedAt: NOW + 1 })
  })

  it("re-activating the active manifest keeps its earlier rollback target", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await activatePredictorManifest(db, "sha-a", { now: NOW + 1 })
    await activatePredictorManifest(db, "sha-b", { now: NOW + 2 })
    const again = await activatePredictorManifest(db, "sha-b", { now: NOW + 3 })
    expect(again.previousManifestSha256).toBe("sha-a")
    expect(again.activatedAt).toBe(NOW + 3)
    expect((await getPredictorManifest(db, "sha-a"))?.deactivatedAt).toBe(NOW + 2)
    expect(await activeShas()).toEqual(["sha-b"])
  })

  it("heals a registry holding two active rows down to exactly one", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await sealPredictorManifest(db, sealInput("sha-c"))
    // A corrupted state no public path produces: two rows marked active.
    await db.fusionPredictorManifests.update("sha-a", { active: 1 })
    await db.fusionPredictorManifests.update("sha-b", { active: 1 })

    const activated = await activatePredictorManifest(db, "sha-c", { now: NOW + 7 })
    expect(await activeShas()).toEqual(["sha-c"])
    expect(["sha-a", "sha-b"]).toContain(activated.previousManifestSha256)
    for (const sha of ["sha-a", "sha-b"]) {
      expect((await getPredictorManifest(db, sha))?.deactivatedAt).toBe(NOW + 7)
    }
  })
})

describe("rollbackPredictorManifest", () => {
  it("refuses when nothing is active", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await expect(rollbackPredictorManifest(db, { now: NOW })).rejects.toMatchObject({
      name: "RoutingRegistryError",
      code: "NO_ACTIVE_MANIFEST",
    })
  })

  it("refuses when the active manifest replaced nothing", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await activatePredictorManifest(db, "sha-a", { now: NOW })
    await expect(rollbackPredictorManifest(db, { now: NOW + 1 })).rejects.toMatchObject({
      code: "NO_ROLLBACK_TARGET",
    })
    expect(await activeShas()).toEqual(["sha-a"])
  })

  it("restores the manifest the active one replaced, and a second rollback undoes the first", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await activatePredictorManifest(db, "sha-a", { now: NOW + 1 })
    await activatePredictorManifest(db, "sha-b", { now: NOW + 2 })

    const restored = await rollbackPredictorManifest(db, { now: NOW + 3 })
    expect(restored).toMatchObject({
      manifestSha256: "sha-a",
      active: 1,
      activatedAt: NOW + 3,
      previousManifestSha256: "sha-b",
    })
    expect(await activeShas()).toEqual(["sha-a"])
    expect((await getPredictorManifest(db, "sha-b"))?.deactivatedAt).toBe(NOW + 3)

    const redone = await rollbackPredictorManifest(db, { now: NOW + 4 })
    expect(redone.manifestSha256).toBe("sha-b")
    expect(await activeShas()).toEqual(["sha-b"])
  })

  it("surfaces a rollback target that no longer exists", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await activatePredictorManifest(db, "sha-a", { now: NOW + 1 })
    await activatePredictorManifest(db, "sha-b", { now: NOW + 2 })
    await db.fusionPredictorManifests.delete("sha-a")
    await expect(rollbackPredictorManifest(db, { now: NOW + 3 })).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
    })
    expect(await activeShas()).toEqual(["sha-b"])
  })
})

describe("deactivatePredictor", () => {
  it("answers null when nothing is active", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await expect(deactivatePredictor(db, { now: NOW })).resolves.toBeNull()
  })

  it("turns the learned router off without deleting or forgetting anything", async () => {
    await sealPredictorManifest(db, sealInput("sha-a"))
    await sealPredictorManifest(db, sealInput("sha-b"))
    await activatePredictorManifest(db, "sha-a", { now: NOW + 1 })
    await activatePredictorManifest(db, "sha-b", { now: NOW + 2 })

    const last = await deactivatePredictor(db, { now: NOW + 9 })
    expect(last).toMatchObject({
      manifestSha256: "sha-b",
      active: 0,
      deactivatedAt: NOW + 9,
      previousManifestSha256: "sha-a",
    })
    await expect(activePredictorManifest(db)).resolves.toBeUndefined()
    expect(await listPredictorManifests(db)).toHaveLength(2)
    // Off is not a rollback target: rollback now has nothing active to move.
    await expect(rollbackPredictorManifest(db, { now: NOW + 10 })).rejects.toMatchObject({
      code: "NO_ACTIVE_MANIFEST",
    })
  })
})

describe("listPredictorManifests / getPredictorManifest", () => {
  it("lists newest first, hash-ordered within one instant, and honours the limit", async () => {
    await sealPredictorManifest(db, sealInput("sha-b", { now: NOW + 1 }))
    await sealPredictorManifest(db, sealInput("sha-a", { now: NOW + 1 }))
    await sealPredictorManifest(db, sealInput("sha-c", { now: NOW + 2 }))
    await sealPredictorManifest(db, sealInput("sha-d", { now: NOW }))
    expect((await listPredictorManifests(db)).map((row) => row.manifestSha256)).toEqual([
      "sha-c",
      "sha-a",
      "sha-b",
      "sha-d",
    ])
    expect(
      (await listPredictorManifests(db, { limit: 2 })).map((row) => row.manifestSha256)
    ).toEqual(["sha-c", "sha-a"])
    await expect(getPredictorManifest(db, "sha-zzz")).resolves.toBeUndefined()
  })
})

describe("shadow decisions", () => {
  it("writes nothing for an empty batch and is idempotent on shadowId", async () => {
    await expect(putShadowDecisions(db, [])).resolves.toBe(0)
    await expect(putShadowDecisions(db, [shadow("s1"), shadow("s2")])).resolves.toBe(2)
    await expect(putShadowDecisions(db, [shadow("s1", { agreed: true })])).resolves.toBe(1)
    const rows = await listShadowDecisions(db)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.shadowId === "s1")?.agreed).toBe(true)
  })

  it("lists newest first, shadowId-ordered within one instant, per predictor and limited", async () => {
    await putShadowDecisions(db, [
      shadow("s-b", { createdAt: NOW }),
      shadow("s-a", { createdAt: NOW }),
      shadow("s-c", { createdAt: NOW + 5 }),
      shadow("s-d", { createdAt: NOW + 9, manifestSha256: "sha-b" }),
    ])
    const ids = async (options?: Parameters<typeof listShadowDecisions>[1]) =>
      (await listShadowDecisions(db, options)).map((row) => row.shadowId)
    expect(await ids()).toEqual(["s-d", "s-c", "s-a", "s-b"])
    expect(await ids({ manifestSha256: "sha-a" })).toEqual(["s-c", "s-a", "s-b"])
    expect(await ids({ manifestSha256: "sha-b" })).toEqual(["s-d"])
    expect(await ids({ manifestSha256: "sha-none" })).toEqual([])
    expect(await ids({ manifestSha256: "sha-a", limit: 1 })).toEqual(["s-c"])
    expect(await ids({ limit: 2 })).toEqual(["s-d", "s-c"])
  })
})
