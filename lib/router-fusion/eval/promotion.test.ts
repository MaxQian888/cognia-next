/**
 * promotion — the refusals in front of promoting a learned router, and the
 * one-click rollback behind it (ADR-0188 D12/D28, B6).
 *
 * The manifests are real: each comes out of `runRoutingExperiment` over the
 * deterministic simulated sample set, and the registry is a real `FusionDB` on
 * fake-indexeddb. A report that "passed live" is the real report with its
 * label and gate overridden, since no simulated run may ever pass for real.
 */

import "fake-indexeddb/auto"

import type { RoutingPredictorManifest } from "@cognia/eval-core"

import { FusionDB } from "../db/fusion-db"
import {
  promoteRoutingPredictor,
  recordRoutingManifest,
  rollbackRoutingPredictor,
  routingPromotionDecision,
} from "./promotion"
import {
  runRoutingExperiment,
  type RoutingExperimentReport,
  type RoutingExperimentResult,
} from "./routing-experiment"
import { ROUTING_FEATURES_VERSION } from "./routing-sample"
import { activePredictorManifest } from "./routing-store"
import { simulatedRoutingSamples } from "./simulated-samples"

const CREATED_AT = "2026-02-01T00:00:00.000Z"

async function experiment(seed: number): Promise<RoutingExperimentResult> {
  return runRoutingExperiment(simulatedRoutingSamples({ seed, sessionCount: 200 }), {
    createdAt: CREATED_AT,
    seed,
    iterations: 50,
  })
}

function publishedOf(result: RoutingExperimentResult): RoutingPredictorManifest {
  if (!result.publishedManifest) throw new Error("fixture experiment published no manifest")
  return result.publishedManifest
}

/** The real report, as if it had come from recorded traffic and passed the gate. */
function passingLive(result: RoutingExperimentResult): RoutingExperimentReport {
  const { report } = result
  if (!report.gate.gate) throw new Error("fixture experiment ran no bootstrap")
  return {
    ...report,
    label: "live",
    gate: {
      ...report.gate,
      passed: true,
      refusals: [],
      gate: { ...report.gate.gate, passed: true, verdict: "pass", reasons: [] },
    },
  }
}

let first: RoutingExperimentResult
let second: RoutingExperimentResult

beforeAll(async () => {
  first = await experiment(1)
  second = await experiment(3)
})

let seq = 0
let db: FusionDB

beforeEach(() => {
  seq += 1
  db = new FusionDB(`promotion-test-${seq}`)
})

afterEach(async () => {
  await db.delete()
})

async function promote(result: RoutingExperimentResult, now: number) {
  return promoteRoutingPredictor(db, {
    report: passingLive(result),
    manifest: publishedOf(result),
    now,
  })
}

describe("fixtures", () => {
  it("are two distinct published manifests of this build's encoding", () => {
    expect(publishedOf(first).sha256).not.toBe(publishedOf(second).sha256)
    for (const result of [first, second]) {
      expect(result.report.publication).toMatchObject({
        status: "published",
        manifestSha256: publishedOf(result).sha256,
      })
      expect(result.report.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
    }
  })
})

describe("routingPromotionDecision", () => {
  it("allows a live, published report whose gate passed on this build's encoding", () => {
    expect(routingPromotionDecision(passingLive(first))).toEqual({ allowed: true, refusals: [] })
  })

  it("refuses the real simulated report however it scored (EVAL-04)", () => {
    const decision = routingPromotionDecision(first.report)
    expect(decision.allowed).toBe(false)
    expect(decision.refusals).toContain("SIMULATED_REPORT")
  })

  it("refuses a simulated report even when its gate passed", () => {
    const report = { ...passingLive(first), label: "simulated" as const }
    expect(routingPromotionDecision(report)).toEqual({
      allowed: false,
      refusals: ["SIMULATED_REPORT"],
    })
  })

  it("refuses a report whose publication was refused", () => {
    const report: RoutingExperimentReport = {
      ...passingLive(first),
      publication: {
        status: "refused",
        reason: "NO_PUBLISHABLE_HEADS",
        problems: ["no head is calibrated"],
        withheldHeads: [],
      },
    }
    expect(routingPromotionDecision(report)).toEqual({
      allowed: false,
      refusals: ["NO_PUBLISHED_MANIFEST"],
    })
  })

  it("refuses an inconclusive gate: 'looked better' is not 'passed'", () => {
    const live = passingLive(first)
    const report: RoutingExperimentReport = { ...live, gate: { ...live.gate, passed: false } }
    expect(routingPromotionDecision(report)).toEqual({
      allowed: false,
      refusals: ["GATE_NOT_PASSED"],
    })
  })

  it("refuses a report of another feature encoding", () => {
    const report = { ...passingLive(first), featuresVersion: "router-fusion-features/0" }
    expect(routingPromotionDecision(report)).toEqual({
      allowed: false,
      refusals: ["FEATURES_VERSION_MISMATCH"],
    })
  })

  it("lists every refusal at once, in a stable order", () => {
    const live = passingLive(first)
    const report: RoutingExperimentReport = {
      ...live,
      label: "simulated",
      publication: {
        status: "refused",
        reason: "MANIFEST_INVALID",
        problems: [],
        withheldHeads: [],
      },
      gate: { ...live.gate, passed: false },
      featuresVersion: "router-fusion-features/0",
    }
    expect(routingPromotionDecision(report)).toEqual({
      allowed: false,
      refusals: [
        "SIMULATED_REPORT",
        "NO_PUBLISHED_MANIFEST",
        "GATE_NOT_PASSED",
        "FEATURES_VERSION_MISMATCH",
      ],
    })
  })
})

describe("promoteRoutingPredictor", () => {
  it("refuses a report the decision refuses, writing nothing", async () => {
    const result = await promoteRoutingPredictor(db, {
      report: first.report,
      manifest: publishedOf(first),
      now: 1_000,
    })
    expect(result).toEqual({
      status: "refused",
      refusals: routingPromotionDecision(first.report).refusals,
    })
    expect(await db.fusionPredictorManifests.count()).toBe(0)
  })

  it("refuses a manifest that is not the one the report published, writing nothing", async () => {
    const result = await promoteRoutingPredictor(db, {
      report: passingLive(first),
      manifest: publishedOf(second),
      now: 1_000,
    })
    expect(result).toEqual({ status: "refused", refusals: ["NO_PUBLISHED_MANIFEST"] })
    expect(await db.fusionPredictorManifests.count()).toBe(0)
  })

  it("seals the published manifest and makes it the one active predictor", async () => {
    const manifest = publishedOf(first)
    const result = await promote(first, 1_000)
    expect(result.status).toBe("promoted")
    if (result.status !== "promoted") return
    expect(result.row).toMatchObject({
      manifestSha256: manifest.sha256,
      kind: "published",
      active: 1,
      featuresVersion: ROUTING_FEATURES_VERSION,
      previousManifestSha256: null,
      label: "live",
      gateVerdict: "pass",
      gateReasons: [],
      activatedAt: 1_000,
      deactivatedAt: null,
      createdAt: 1_000,
    })
    // The manifest document is stored verbatim, so its seal can be re-verified.
    expect(result.row.manifest).toEqual(manifest)
    expect(await db.fusionPredictorManifests.get(manifest.sha256)).toEqual(result.row)
    expect((await activePredictorManifest(db))?.manifestSha256).toBe(manifest.sha256)
  })

  it("records the bootstrap's own verdict and reasons on the row, verbatim", async () => {
    const live = passingLive(first)
    const report: RoutingExperimentReport = {
      ...live,
      gate: {
        ...live.gate,
        gate: live.gate.gate ? { ...live.gate.gate, reasons: ["INSUFFICIENT_GROUPS"] } : null,
      },
    }
    const result = await promoteRoutingPredictor(db, {
      report,
      manifest: publishedOf(first),
      now: 1_000,
    })
    expect(result).toMatchObject({
      status: "promoted",
      row: { gateVerdict: "pass", gateReasons: ["INSUFFICIENT_GROUPS"] },
    })
  })

  it("falls back to the gate's refusals when no bootstrap result is attached", async () => {
    const live = passingLive(first)
    const report: RoutingExperimentReport = {
      ...live,
      gate: { ...live.gate, gate: null, refusals: ["DETERMINISTIC_LOGGING"] },
    }
    const result = await promoteRoutingPredictor(db, {
      report,
      manifest: publishedOf(first),
      now: 1_000,
    })
    expect(result).toMatchObject({
      status: "promoted",
      row: { gateVerdict: null, gateReasons: ["DETERMINISTIC_LOGGING"] },
    })
  })

  it("remembers the manifest a promotion replaced as its rollback target", async () => {
    await promote(first, 1_000)
    const result = await promote(second, 2_000)
    expect(result).toMatchObject({
      status: "promoted",
      row: {
        manifestSha256: publishedOf(second).sha256,
        active: 1,
        previousManifestSha256: publishedOf(first).sha256,
        activatedAt: 2_000,
      },
    })
    expect(await db.fusionPredictorManifests.get(publishedOf(first).sha256)).toMatchObject({
      active: 0,
      deactivatedAt: 2_000,
    })
    const active = await db.fusionPredictorManifests.filter((row) => row.active === 1).toArray()
    expect(active).toHaveLength(1)
  })

  it("re-promoting the active manifest keeps one active row and its rollback target", async () => {
    await promote(first, 1_000)
    await promote(second, 2_000)
    const again = await promote(second, 3_000)
    expect(again).toMatchObject({
      status: "promoted",
      row: { active: 1, activatedAt: 3_000, previousManifestSha256: publishedOf(first).sha256 },
    })
    expect(await db.fusionPredictorManifests.filter((row) => row.active === 1).count()).toBe(1)
    expect(await db.fusionPredictorManifests.count()).toBe(2)
  })

  it("refuses to activate a manifest trained on another encoding than the report claims", async () => {
    const manifest = { ...publishedOf(first), featuresVersion: "router-fusion-features/0" }
    await expect(
      promoteRoutingPredictor(db, { report: passingLive(first), manifest, now: 1_000 })
    ).rejects.toMatchObject({ name: "RoutingRegistryError", code: "FEATURES_VERSION_MISMATCH" })
    expect(await activePredictorManifest(db)).toBeUndefined()
  })
})

describe("recordRoutingManifest", () => {
  it("records a training manifest for audit without activating it", async () => {
    const row = await recordRoutingManifest(db, {
      manifest: first.trainingManifest,
      label: "simulated",
      gateVerdict: "inconclusive",
      gateReasons: ["too few groups"],
      now: 4_000,
    })
    expect(row).toMatchObject({
      manifestSha256: first.trainingManifest.sha256,
      kind: "training",
      active: 0,
      featuresVersion: ROUTING_FEATURES_VERSION,
      label: "simulated",
      gateVerdict: "inconclusive",
      gateReasons: ["too few groups"],
      activatedAt: null,
      createdAt: 4_000,
    })
    expect(row.manifest).toEqual(first.trainingManifest)
    expect(await db.fusionPredictorManifests.get(first.trainingManifest.sha256)).toEqual(row)
    expect(await activePredictorManifest(db)).toBeUndefined()
  })

  it("keeps the kind the manifest itself declares", async () => {
    const row = await recordRoutingManifest(db, {
      manifest: publishedOf(first),
      label: "simulated",
      gateVerdict: null,
      gateReasons: [],
      now: 4_000,
    })
    expect(row).toMatchObject({ kind: "published", active: 0, gateVerdict: null })
  })

  it("re-recording the active manifest updates its verdict and leaves its activation alone", async () => {
    await promote(first, 1_000)
    await promote(second, 2_000)
    const row = await recordRoutingManifest(db, {
      manifest: publishedOf(second),
      label: "live",
      gateVerdict: "fail",
      gateReasons: ["pass rate below margin"],
      now: 9_000,
    })
    expect(row).toMatchObject({
      active: 1,
      activatedAt: 2_000,
      previousManifestSha256: publishedOf(first).sha256,
      gateVerdict: "fail",
      gateReasons: ["pass rate below margin"],
      // A re-seal keeps the row's original creation time.
      createdAt: 2_000,
    })
  })
})

describe("rollbackRoutingPredictor", () => {
  it("restores the manifest the active one replaced", async () => {
    await promote(first, 1_000)
    await promote(second, 2_000)
    const result = await rollbackRoutingPredictor(db, { now: 3_000 })
    expect(result).toMatchObject({
      status: "rolled_back",
      row: { manifestSha256: publishedOf(first).sha256, active: 1, activatedAt: 3_000 },
    })
    expect(await db.fusionPredictorManifests.get(publishedOf(second).sha256)).toMatchObject({
      active: 0,
      deactivatedAt: 3_000,
    })
    expect((await activePredictorManifest(db))?.manifestSha256).toBe(publishedOf(first).sha256)
  })

  it("a second rollback undoes the first", async () => {
    await promote(first, 1_000)
    await promote(second, 2_000)
    await rollbackRoutingPredictor(db, { now: 3_000 })
    const result = await rollbackRoutingPredictor(db, { now: 4_000 })
    expect(result).toMatchObject({
      status: "rolled_back",
      row: { manifestSha256: publishedOf(second).sha256, active: 1, activatedAt: 4_000 },
    })
  })

  it("switches the learned router off after a first promotion, which had nothing to restore", async () => {
    await promote(first, 1_000)
    const result = await rollbackRoutingPredictor(db, { now: 3_000 })
    expect(result).toMatchObject({
      status: "deactivated",
      row: { manifestSha256: publishedOf(first).sha256, active: 0, deactivatedAt: 3_000 },
    })
    expect(await activePredictorManifest(db)).toBeUndefined()
    // Off, not deleted: the manifest stays in the registry.
    expect(await db.fusionPredictorManifests.count()).toBe(1)
  })

  it("refuses when no learned router is active", async () => {
    await recordRoutingManifest(db, {
      manifest: publishedOf(first),
      label: "live",
      gateVerdict: "pass",
      gateReasons: [],
      now: 1_000,
    })
    await expect(rollbackRoutingPredictor(db, { now: 3_000 })).resolves.toEqual({
      status: "refused",
      code: "NO_ACTIVE_MANIFEST",
      message: "no learned router is active",
    })
  })

  it("refuses, leaving the active manifest in place, when its rollback target is gone", async () => {
    await promote(first, 1_000)
    await promote(second, 2_000)
    await db.fusionPredictorManifests.delete(publishedOf(first).sha256)
    const result = await rollbackRoutingPredictor(db, { now: 3_000 })
    expect(result).toMatchObject({ status: "refused", code: "MANIFEST_NOT_FOUND" })
    if (result.status === "refused") expect(result.message).toContain(publishedOf(first).sha256)
    expect((await activePredictorManifest(db))?.manifestSha256).toBe(publishedOf(second).sha256)
  })

  it("rethrows a failure that is not a registry refusal", async () => {
    const fault = new Error("the fusion database went away")
    const broken = {
      fusionPredictorManifests: {
        filter: () => {
          throw fault
        },
      },
    } as unknown as FusionDB
    await expect(rollbackRoutingPredictor(broken, { now: 3_000 })).rejects.toBe(fault)
  })
})
