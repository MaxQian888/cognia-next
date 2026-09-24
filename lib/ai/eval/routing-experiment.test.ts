/**
 * routing-experiment — the host seam of the `routing` evaluation mode
 * (ADR-0188 D12/D28, B6).
 *
 * The offline half runs the real engine end to end over the real simulated
 * generator. The database-backed workspace runs the real routing store,
 * collector, shadow router, promotion guard and generic recommendation
 * apply/rollback over a real fusion database on fake-indexeddb; only the I/O
 * boundaries are replaced — the account's fusion store handle (`host`,
 * `store-provider`), the gate's settings read, and the account-database
 * dependencies the generic apply records its rows in.
 */

import "fake-indexeddb/auto"

import { ROUTER_FUSION_SURFACES } from "@cognia/router-fusion/settings/switches"

import { FusionDB } from "@/lib/router-fusion/db/fusion-db"
import { encodeRunInput } from "@/lib/router-fusion/db/run-input"
import type { FusionRoutingSampleRow, FusionRunRow } from "@/lib/router-fusion/db/types"
import {
  LIVE_ROUTING_DISCLAIMER,
  SIMULATED_ROUTING_DISCLAIMER,
} from "@/lib/router-fusion/eval/routing-experiment"
import {
  buildRoutingSampleExport,
  ROUTING_FEATURE_NAMES,
  ROUTING_FEATURES_VERSION,
  ROUTING_SAMPLE_EXPORT_SCHEMA,
} from "@/lib/router-fusion/eval/routing-sample"
import { putRoutingSamples, routingSampleExpiry } from "@/lib/router-fusion/eval/routing-store"
import { simulatedRoutingSamples } from "@/lib/router-fusion/eval/simulated-samples"
import type { EvalConfigurationApplyRow } from "@/lib/db/eval-lab"
import { currentFusionStore as providerCurrentFusionStore } from "@/lib/router-fusion/chat/store-provider"
import { currentRouterFusionGateSettings } from "@/lib/router-fusion/gate/current-settings"
import { currentFusionStore as hostCurrentFusionStore } from "@/lib/router-fusion/host"

import {
  browserEvalConfigurationApplicationDeps,
  createEvalConfigurationApplicationDeps,
} from "./configuration-targets"

import {
  openRoutingEvalWorkspace,
  parseRoutingSamples,
  ROUTING_EVAL_MODE,
  ROUTING_PREDICTOR_TARGET,
  routingExperimentAvailable,
  runRecordedRoutingExperiment,
  runSimulatedRoutingExperiment,
  type RoutingExperimentResult,
  type RoutingExperimentSettings,
} from "./routing-experiment"

jest.mock("@/lib/router-fusion/host", () => ({ currentFusionStore: jest.fn() }))
jest.mock("@/lib/router-fusion/chat/store-provider", () => ({ currentFusionStore: jest.fn() }))
jest.mock("@/lib/router-fusion/gate/current-settings", () => ({
  currentRouterFusionGateSettings: jest.fn(),
}))
jest.mock("./configuration-targets", () => ({
  ...jest.requireActual("./configuration-targets"),
  browserEvalConfigurationApplicationDeps: jest.fn(),
}))

const hostStoreMock = hostCurrentFusionStore as jest.Mock
const providerStoreMock = providerCurrentFusionStore as jest.Mock
const gateSettingsMock = currentRouterFusionGateSettings as jest.Mock
const applicationDepsMock = browserEvalConfigurationApplicationDeps as jest.Mock

const CREATED_AT = "2026-03-01T00:00:00.000Z"
const LATER = "2026-03-02T00:00:00.000Z"
/** Bootstrap replicates for the tests; the product never lowers it. */
const ITERATIONS = 20

const ON: RoutingExperimentSettings = {
  routerFusion: { enabled: true, surfaces: { chat: true } },
}

/** Simulated rows re-labelled as recorded traffic, so the report is `live`. */
function recordedRows(seed = 11): FusionRoutingSampleRow[] {
  return simulatedRoutingSamples({ seed }).map((row) => ({ ...row, origin: "recorded" }))
}

describe("routing evaluation mode constants", () => {
  it("names the host-only mode and the learned router's configuration target", () => {
    expect(ROUTING_EVAL_MODE).toBe("routing")
    expect(ROUTING_PREDICTOR_TARGET).toEqual({
      targetType: "routing-predictor",
      targetId: "router-fusion",
    })
  })
})

describe("routingExperimentAvailable", () => {
  it("is off without settings, without a Router + Fusion block or with the master switch off", () => {
    expect(routingExperimentAvailable(null)).toBe(false)
    expect(routingExperimentAvailable(undefined)).toBe(false)
    expect(routingExperimentAvailable({})).toBe(false)
    expect(routingExperimentAvailable({ routerFusion: null })).toBe(false)
    expect(
      routingExperimentAvailable({ routerFusion: { enabled: false, surfaces: { chat: true } } })
    ).toBe(false)
  })

  it("is off when the master switch is on but every surface is off", () => {
    expect(routingExperimentAvailable({ routerFusion: { enabled: true } })).toBe(false)
    expect(routingExperimentAvailable({ routerFusion: { enabled: true, surfaces: null } })).toBe(
      false
    )
    const allOff = Object.fromEntries(ROUTER_FUSION_SURFACES.map((surface) => [surface, false]))
    expect(routingExperimentAvailable({ routerFusion: { enabled: true, surfaces: allOff } })).toBe(
      false
    )
  })

  it("treats a truthy value that is not literally true as off", () => {
    expect(
      routingExperimentAvailable({ routerFusion: { enabled: "true", surfaces: { chat: true } } })
    ).toBe(false)
    expect(
      routingExperimentAvailable({ routerFusion: { enabled: true, surfaces: { chat: 1 } } })
    ).toBe(false)
  })

  it.each(ROUTER_FUSION_SURFACES)("is on when only the %s surface is on", (surface) => {
    expect(
      routingExperimentAvailable({ routerFusion: { enabled: true, surfaces: { [surface]: true } } })
    ).toBe(true)
  })
})

describe("runSimulatedRoutingExperiment", () => {
  it("labels the report simulated and claims nothing, however the numbers look (EVAL-04)", async () => {
    const result = await runSimulatedRoutingExperiment({
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })
    const { report } = result

    expect(report.label).toBe("simulated")
    expect(report.disclaimer).toBe(SIMULATED_ROUTING_DISCLAIMER)
    expect(report.caveats).toContain(SIMULATED_ROUTING_DISCLAIMER)
    expect(report.claims).toEqual({ quality: null, costSavingMicrousd: null })
    expect(report.createdAt).toBe(CREATED_AT)
    expect(report.featuresVersion).toBe(ROUTING_FEATURES_VERSION)
    expect(report.sampleCount).toBe(simulatedRoutingSamples({ seed: 1 }).length)
    expect(result.trainingManifest.kind).toBe("training")
    expect(report.training.manifestSha256).toBe(result.trainingManifest.sha256)
  })

  it("counts every run's cost over the accepted runs alone (EVAL-03)", async () => {
    const rows = simulatedRoutingSamples({ seed: 1 })
    const { report } = await runSimulatedRoutingExperiment({
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })
    const total = rows.reduce((sum, row) => sum + row.costMicrousd, 0)
    const accepted = rows.filter((row) => row.accepted).length
    expect(report.acceptedCost).toEqual({
      runCount: rows.length,
      acceptedCount: accepted,
      totalCostMicrousd: total,
      costPerAcceptedMicrousd: total / accepted,
      passRate: accepted / rows.length,
    })
    expect(report.byAction.reduce((sum, row) => sum + row.runCount, 0)).toBe(rows.length)
  })

  it("is a pure function of the seed and timestamp", async () => {
    const options = { seed: 5, createdAt: CREATED_AT, iterations: ITERATIONS }
    const first = await runSimulatedRoutingExperiment(options)
    const second = await runSimulatedRoutingExperiment(options)
    const reseeded = await runSimulatedRoutingExperiment({ ...options, seed: 6 })

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(reseeded.trainingManifest.sha256).not.toBe(first.trainingManifest.sha256)
  })

  it("equals the recorded path run over the same generated rows", async () => {
    const simulated = await runSimulatedRoutingExperiment({
      seed: 3,
      createdAt: CREATED_AT,
      sessionCount: 120,
      explorationRate: 0.4,
      iterations: ITERATIONS,
    })
    const rows = simulatedRoutingSamples({
      seed: 3,
      sessionCount: 120,
      explorationRate: 0.4,
      now: Date.parse(CREATED_AT),
    })
    const replayed = await runRecordedRoutingExperiment(rows, {
      seed: 3,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })

    expect(simulated.report.sampleCount).toBe(rows.length)
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(simulated))
  })

  it("forwards the bootstrap iterations and falls back to the product default without them", async () => {
    const lowered = await runSimulatedRoutingExperiment({
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })
    expect(lowered.report.gate.gate?.iterations).toBe(ITERATIONS)

    const product = await runSimulatedRoutingExperiment({ seed: 1, createdAt: CREATED_AT })
    expect(product.report.gate.gate?.iterations).toBe(10_000)
  })

  it("refuses to compare policies on a log without randomization", async () => {
    const { report } = await runSimulatedRoutingExperiment({
      seed: 2,
      createdAt: CREATED_AT,
      explorationRate: 0,
      iterations: ITERATIONS,
    })
    expect(report.publication.status).toBe("published")
    expect(report.gate.gate).toBeNull()
    expect(report.gate.passed).toBe(false)
    expect(report.gate.refusals).toEqual(["DETERMINISTIC_LOGGING"])
    expect(report.caveats.some((caveat) => caveat.includes("propensity 1"))).toBe(true)
  })

  it("rejects options the generator cannot honour", async () => {
    await expect(
      runSimulatedRoutingExperiment({ seed: 1, createdAt: CREATED_AT, sessionCount: 0 })
    ).rejects.toThrow(/sessionCount must be a positive integer/)
    await expect(
      runSimulatedRoutingExperiment({ seed: 1, createdAt: CREATED_AT, explorationRate: 2 })
    ).rejects.toThrow(/explorationRate must be within/)
    await expect(
      runSimulatedRoutingExperiment({ seed: 1.5, createdAt: CREATED_AT })
    ).rejects.toThrow(/integer seed/)
  })
})

describe("runRecordedRoutingExperiment", () => {
  it("labels recorded traffic live", async () => {
    const result = await runRecordedRoutingExperiment(recordedRows(), {
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })
    expect(result.report.label).toBe("live")
    expect(result.report.disclaimer).toBe(LIVE_ROUTING_DISCLAIMER)
    expect(result.report.caveats).not.toContain(SIMULATED_ROUTING_DISCLAIMER)
    expect(result.report.gate.gate?.iterations).toBe(ITERATIONS)
  })

  it("refuses an empty set, a mixed set and a foreign encoding", async () => {
    const options = { seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS }
    await expect(runRecordedRoutingExperiment([], options)).rejects.toThrow(/at least one sample/)

    const [first, ...rest] = recordedRows()
    await expect(
      runRecordedRoutingExperiment([{ ...first, origin: "simulated" }, ...rest], options)
    ).rejects.toThrow(/mixes recorded and simulated/)

    const foreign = recordedRows().map((row) => ({ ...row, featuresVersion: "legacy/0" }))
    await expect(runRecordedRoutingExperiment(foreign, options)).rejects.toThrow(
      new RegExp(`samples encode legacy/0; this build encodes ${ROUTING_FEATURES_VERSION}`)
    )
  })
})

describe("parseRoutingSamples", () => {
  it("reads an export back into rows stamped with the read time", async () => {
    const rows = simulatedRoutingSamples({ seed: 4, sessionCount: 5 })
    const exported = buildRoutingSampleExport(rows, { exportedAt: CREATED_AT })
    const now = Date.parse(LATER)

    const parsed = await parseRoutingSamples(JSON.parse(JSON.stringify(exported)), { now })

    expect(parsed).toHaveLength(rows.length)
    for (const [index, row] of parsed.entries()) {
      const source = rows[index]
      expect(row).toMatchObject({
        sampleId: source.sampleId,
        runId: source.sampleId,
        groupId: source.groupId,
        actionId: source.actionId,
        features: source.features,
        propensity: source.propensity,
        costMicrousd: source.costMicrousd,
        accepted: source.accepted,
        origin: "simulated",
        featuresVersion: ROUTING_FEATURES_VERSION,
        createdAt: now,
        expiresAt: now,
      })
    }
  })

  it("refuses a document it cannot vouch for, naming what is wrong", async () => {
    const options = { now: 1 }
    await expect(parseRoutingSamples(null, options)).rejects.toThrow(/must be an object/)
    await expect(parseRoutingSamples({ schema: "other/v1" }, options)).rejects.toThrow(
      /schema must be/
    )

    const rows = simulatedRoutingSamples({ seed: 4, sessionCount: 2 })
    const exported = buildRoutingSampleExport(rows, { exportedAt: CREATED_AT })
    const tampered = {
      ...exported,
      rows: exported.rows.map((row, index) => (index === 1 ? { ...row, propensity: 0 } : row)),
    }
    await expect(parseRoutingSamples(tampered, options)).rejects.toThrow(
      /routing sample 1: propensity must be within \(0, 1\]/
    )
    expect(exported.schema).toBe(ROUTING_SAMPLE_EXPORT_SCHEMA)
    expect(exported.featureNames).toEqual([...ROUTING_FEATURE_NAMES])
  })
})

describe("openRoutingEvalWorkspace", () => {
  let db: FusionDB
  let artifacts: Map<string, string>
  let records: Map<string, EvalConfigurationApplyRow>
  let idCounter: number
  let clock: number

  beforeEach(async () => {
    db = new FusionDB(`routing-experiment-test-${Math.random().toString(36).slice(2)}`)
    await db.open()
    artifacts = new Map()
    records = new Map()
    idCounter = 0
    clock = Date.parse(CREATED_AT)

    const fusionStore = {
      db,
      artifactStore: (runId: string | null) => ({
        get: async (artifactId: string) => {
          const content = artifacts.get(`${runId}/${artifactId}`)
          return content === undefined ? undefined : { content }
        },
      }),
    }
    hostStoreMock.mockReset().mockResolvedValue(fusionStore)
    providerStoreMock.mockReset().mockResolvedValue(fusionStore)
    gateSettingsMock.mockReset().mockResolvedValue(ON)
    applicationDepsMock.mockReset().mockImplementation(async () =>
      createEvalConfigurationApplicationDeps({
        getSettings: async () => {
          throw new Error("the routing predictor never reads app settings")
        },
        saveSettings: async () => {
          throw new Error("the routing predictor never writes app settings")
        },
        getCharacter: async () => undefined,
        updateCharacter: async () => {},
        getWorkflow: async () => undefined,
        updateWorkflow: async () => undefined,
        saveRecord: async (record) => void records.set(record.id, structuredClone(record)),
        getRecord: async (id) => records.get(id),
        updateRecord: async (id, patch) => {
          const current = records.get(id)
          if (current) records.set(id, { ...current, ...patch })
        },
        now: () => clock,
        newId: () => `apply-${++idCounter}`,
      })
    )
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  const open = () => openRoutingEvalWorkspace(ON, { now: () => clock })

  /** A report whose gate passed: what a promotable live run looks like. */
  function passing(result: RoutingExperimentResult): RoutingExperimentResult {
    return {
      ...result,
      report: { ...result.report, gate: { ...result.report.gate, passed: true } },
    }
  }

  it("refuses while every surface is off, without opening the fusion database", async () => {
    await expect(openRoutingEvalWorkspace(null)).rejects.toThrow(
      "Router + Fusion is off on every surface; the routing experiment is unavailable"
    )
    await expect(
      openRoutingEvalWorkspace({ routerFusion: { enabled: true, surfaces: { chat: false } } })
    ).rejects.toThrow(/unavailable/)
    expect(hostStoreMock).not.toHaveBeenCalled()
  })

  it("lists stored samples in sample order, honouring since and limit", async () => {
    const rows = simulatedRoutingSamples({ seed: 9, sessionCount: 10 })
    await putRoutingSamples(db, rows)
    const workspace = await open()

    const listed = await workspace.listSamples()
    const ordered = [...rows].sort((left, right) => left.sampleId.localeCompare(right.sampleId))
    expect(listed.map((row) => row.sampleId)).toEqual(ordered.map((row) => row.sampleId))
    expect(await workspace.listSamples({ limit: 3 })).toHaveLength(3)

    const cutoff = Math.max(...rows.map((row) => row.decidedAt))
    const latest = await workspace.listSamples({ since: cutoff })
    expect(latest.length).toBeGreaterThan(0)
    expect(latest.every((row) => row.decidedAt >= cutoff)).toBe(true)
  })

  it("exports the stored samples with their propensity, stamped by the injected clock", async () => {
    const rows = recordedRows().slice(0, 12)
    await putRoutingSamples(db, rows)
    const workspace = await open()

    const exported = await workspace.exportSamples()

    expect(exported.schema).toBe(ROUTING_SAMPLE_EXPORT_SCHEMA)
    expect(exported.label).toBe("live")
    expect(exported.exportedAt).toBe(CREATED_AT)
    expect(exported.sampleCount).toBe(12)
    expect(exported.rows.map((row) => row.propensity)).toEqual(
      [...rows]
        .sort((left, right) => left.sampleId.localeCompare(right.sampleId))
        .map((row) => row.propensity)
    )
    expect((await workspace.exportSamples({ limit: 2 })).sampleCount).toBe(2)
  })

  it("collects terminal runs, reading their input through the store's artifacts", async () => {
    const runBase = {
      sessionId: "session-1",
      mode: "direct",
      actionId: "direct_economy",
      actionHash: "hash-direct-economy",
      ruleId: "R2_economy_simple",
      costStatus: "actual",
      budget: { spentMicrousd: 1234.4 },
      createdAt: 1_000,
      updatedAt: 2_000,
      terminalAt: 2_000,
    }
    const runs = [
      {
        ...runBase,
        runId: "run-collected",
        decisionId: "decision-collected",
        status: "succeeded",
        inputArtifactId: "input-1",
      },
      {
        ...runBase,
        runId: "run-input-gone",
        decisionId: "decision-input-gone",
        status: "succeeded",
        inputArtifactId: "input-2",
      },
      {
        ...runBase,
        runId: "run-still-going",
        decisionId: "decision-still-going",
        status: "running",
        inputArtifactId: "input-3",
        terminalAt: null,
      },
    ]
    await db.fusionRuns.bulkPut(runs as unknown as FusionRunRow[])
    for (const run of runs) {
      await db.fusionRouteDecisions.put({
        decisionId: run.decisionId,
        runId: run.runId,
        decision: { selected_action_id: "direct_economy" } as never,
        createdAt: 1_500,
      })
    }
    await db.fusionRunEvents.put({
      runId: "run-collected",
      seq: 1,
      type: "answer.completed",
      payload: { quality_status: "accepted" },
      createdAt: 1_900,
    })
    artifacts.set(
      "run-collected/input-1",
      encodeRunInput({
        messages: [{ role: "user", content: "Summarise this paragraph in one line." }],
        allowDegraded: false,
        jsonSchema: null,
      })
    )
    const workspace = await open()

    const outcome = await workspace.collect()

    expect(outcome).toEqual({
      scanned: 3,
      collected: 1,
      skipped: [
        { runId: "run-input-gone", reason: "input_unavailable" },
        { runId: "run-still-going", reason: "not_terminal" },
      ],
    })
    const [sample] = await workspace.listSamples()
    expect(sample).toMatchObject({
      runId: "run-collected",
      groupId: "session-1",
      actionId: "direct_economy",
      origin: "recorded",
      propensity: 1,
      costMicrousd: 1234,
      accepted: true,
      qualityStatus: "accepted",
      decidedAt: 1_500,
      createdAt: clock,
      expiresAt: routingSampleExpiry(clock),
      featuresVersion: ROUTING_FEATURES_VERSION,
    })
    expect(sample.features).toHaveLength(ROUTING_FEATURE_NAMES.length)

    // `since` filters on when the run ended; nothing ended after 2 000.
    expect(await workspace.collect({ since: 2_001 })).toEqual({
      scanned: 0,
      collected: 0,
      skipped: [],
    })
  })

  it("runs the experiment over this build's encoding and leaves its manifest in the registry", async () => {
    const rows = recordedRows()
    await putRoutingSamples(db, [
      ...rows,
      // A sample of another encoding is left out of training rather than refusing the set.
      { ...rows[0], sampleId: "zz-foreign", featuresVersion: "legacy/0" },
    ])
    const workspace = await open()

    const result = await workspace.runExperiment({
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })

    expect(result.report.label).toBe("live")
    expect(result.report.sampleCount).toBe(rows.length)
    expect(result.publishedManifest).not.toBeNull()
    const manifests = await workspace.listManifests()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({
      manifestSha256: result.publishedManifest?.sha256,
      kind: "published",
      active: 0,
      label: "live",
      gateVerdict: result.report.gate.gate?.verdict ?? null,
      gateReasons: result.report.gate.gate?.reasons ?? result.report.gate.refusals,
      createdAt: clock,
    })
    expect(await workspace.activeManifest()).toBeUndefined()
    expect(await workspace.listManifests({ limit: 0 })).toEqual([])
  })

  it("records the training manifest when nothing could be published", async () => {
    // Two sessions cannot fill a training, a calibration and a test window.
    await putRoutingSamples(
      db,
      simulatedRoutingSamples({ seed: 1, sessionCount: 2 }).map((row) => ({
        ...row,
        origin: "recorded" as const,
      }))
    )
    const workspace = await open()

    const result = await workspace.runExperiment({ seed: 1, createdAt: CREATED_AT })

    expect(result.publishedManifest).toBeNull()
    expect(result.report.gate.refusals).toEqual(["NO_PREDICTOR"])
    const [row] = await workspace.listManifests()
    expect(row).toMatchObject({
      manifestSha256: result.trainingManifest.sha256,
      kind: "training",
      gateVerdict: null,
      gateReasons: ["NO_PREDICTOR"],
    })
  })

  it("refuses to run an experiment with no stored samples", async () => {
    const workspace = await open()
    await expect(
      workspace.runExperiment({ seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS })
    ).rejects.toThrow(/at least one sample/)
    expect(await workspace.listManifests()).toEqual([])
  })

  it("has nothing to shadow before a predictor is promoted", async () => {
    await putRoutingSamples(db, recordedRows().slice(0, 5))
    const workspace = await open()
    expect(await workspace.shadow()).toEqual({ status: "no_predictor" })
    expect(await workspace.listShadowDecisions()).toEqual([])
  })

  it("refuses to promote a simulated report or one whose gate did not pass", async () => {
    const workspace = await open()
    const simulated = await runSimulatedRoutingExperiment({
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })

    expect(await workspace.promote(simulated)).toEqual({
      status: "refused",
      refusals: ["SIMULATED_REPORT", "GATE_NOT_PASSED"],
    })
    expect(await workspace.listManifests()).toEqual([])
    expect(applicationDepsMock).not.toHaveBeenCalled()

    await putRoutingSamples(db, recordedRows())
    const live = await workspace.runExperiment({
      seed: 1,
      createdAt: CREATED_AT,
      iterations: ITERATIONS,
    })
    expect(live.report.gate.passed).toBe(false)
    expect(await workspace.promote(live)).toEqual({
      status: "refused",
      refusals: ["GATE_NOT_PASSED"],
    })
    expect(await workspace.activeManifest()).toBeUndefined()
  })

  it("refuses a passing report that carries no published manifest", async () => {
    await putRoutingSamples(db, recordedRows())
    const workspace = await open()
    const live = passing(
      await workspace.runExperiment({ seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS })
    )

    expect(await workspace.promote({ ...live, publishedManifest: null })).toEqual({
      status: "refused",
      refusals: ["NO_PUBLISHED_MANIFEST"],
    })
    expect(await workspace.activeManifest()).toBeUndefined()
    expect(records.size).toBe(0)
  })

  it("promotes through the generic apply, shadows with the active predictor and rolls back by record", async () => {
    await putRoutingSamples(db, recordedRows())
    const workspace = await open()
    const live = passing(
      await workspace.runExperiment({ seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS })
    )
    const published = live.publishedManifest!

    const outcome = await workspace.promote(live)

    expect(outcome).toEqual({
      status: "promoted",
      manifestSha256: published.sha256,
      applicationId: "apply-1",
    })
    expect(records.get("apply-1")).toMatchObject({
      experimentId: live.report.training.manifestSha256,
      ...ROUTING_PREDICTOR_TARGET,
      previousConfiguration: { manifestSha256: null },
      appliedConfiguration: { manifestSha256: published.sha256 },
      appliedAt: clock,
    })
    expect(await workspace.activeManifest()).toMatchObject({
      manifestSha256: published.sha256,
      active: 1,
      kind: "published",
    })

    const shadow = await workspace.shadow({ limit: 40 })
    expect(shadow.status).toBe("recorded")
    if (shadow.status !== "recorded") throw new Error("unreachable")
    expect(shadow.manifestSha256).toBe(published.sha256)
    expect(shadow.stored).toBe(40)
    expect(shadow.summary.evaluated).toBe(40)
    const decisions = await workspace.listShadowDecisions({ limit: 5 })
    expect(decisions).toHaveLength(5)
    expect(decisions.every((row) => row.manifestSha256 === published.sha256)).toBe(true)

    // Applying the same pointer again is not a change the generic apply will record.
    await expect(workspace.promote(live)).rejects.toThrow(/already applied/)

    clock += 60_000
    expect(await workspace.rollback("apply-1")).toEqual({ status: "deactivated", row: null })
    expect(await workspace.activeManifest()).toBeUndefined()
    expect(records.get("apply-1")?.rolledBackAt).toBe(clock)
    await expect(workspace.rollback("apply-1")).rejects.toThrow(/already rolled back/)
  })

  it("restores the manifest a promotion replaced", async () => {
    await putRoutingSamples(db, recordedRows())
    const workspace = await open()
    const first = passing(
      await workspace.runExperiment({ seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS })
    )
    const second = passing(
      await workspace.runExperiment({ seed: 1, createdAt: LATER, iterations: ITERATIONS })
    )
    expect(second.publishedManifest!.sha256).not.toBe(first.publishedManifest!.sha256)

    await workspace.promote(first)
    const promoted = await workspace.promote(second)
    if (promoted.status !== "promoted") throw new Error("expected a promotion")
    expect((await workspace.activeManifest())?.manifestSha256).toBe(
      second.publishedManifest!.sha256
    )

    const restored = await workspace.rollback(promoted.applicationId)

    expect(restored).toMatchObject({
      status: "rolled_back",
      row: { manifestSha256: first.publishedManifest!.sha256, active: 1 },
    })
    expect((await workspace.activeManifest())?.manifestSha256).toBe(first.publishedManifest!.sha256)
  })

  it("moves the registry pointer itself when rolled back without an apply record", async () => {
    await putRoutingSamples(db, recordedRows())
    const workspace = await open()

    const nothingActive = await workspace.rollback()
    expect(nothingActive).toMatchObject({ status: "refused", code: "NO_ACTIVE_MANIFEST" })

    const first = passing(
      await workspace.runExperiment({ seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS })
    )
    const second = passing(
      await workspace.runExperiment({ seed: 1, createdAt: LATER, iterations: ITERATIONS })
    )

    // The first promotion replaced nothing, so stepping back switches the learned router off.
    await workspace.promote(first)
    const off = await workspace.rollback()
    expect(off).toMatchObject({
      status: "deactivated",
      row: { manifestSha256: first.publishedManifest!.sha256, active: 0 },
    })
    expect(await workspace.activeManifest()).toBeUndefined()

    // A promotion over an active manifest steps back to it.
    await workspace.promote(first)
    await workspace.promote(second)
    const back = await workspace.rollback()
    expect(back).toMatchObject({
      status: "rolled_back",
      row: { manifestSha256: first.publishedManifest!.sha256, active: 1 },
    })
    expect((await workspace.activeManifest())?.manifestSha256).toBe(first.publishedManifest!.sha256)
  })

  it("moves no pointer and records no apply when the gate reads Router + Fusion as off", async () => {
    await putRoutingSamples(db, recordedRows())
    const workspace = await open()
    const live = passing(
      await workspace.runExperiment({ seed: 1, createdAt: CREATED_AT, iterations: ITERATIONS })
    )
    gateSettingsMock.mockResolvedValue(null)

    await expect(workspace.promote(live)).rejects.toThrow(
      /Router \+ Fusion is off on every surface; the learned router cannot be changed/
    )
    expect(await workspace.activeManifest()).toBeUndefined()
    expect(records.size).toBe(0)
  })
})
