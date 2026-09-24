/**
 * sample-collector — the read model that turns terminal, settled runs in the
 * fusion database into routing samples (fake-indexeddb).
 */

import "fake-indexeddb/auto"

import { CONTRACT_SCHEMA_VERSION, type Message, type RouteDecision } from "@cognia/router-fusion"

import { FusionDB } from "../db/fusion-db"
import { encodeRunInput } from "../db/run-input"
import type { FusionRunEventRow, FusionRunRow } from "../db/types"
import { runFeatures } from "../routing/run-route"
import { encodeRoutingFeatures, ROUTING_FEATURES_VERSION, sampleIdFor } from "./routing-sample"
import { countRoutingSamples, listRoutingSamples, routingSampleExpiry } from "./routing-store"
import {
  collectRoutingSamples,
  qualityStatusOf,
  type CollectRoutingSamplesDeps,
} from "./sample-collector"

const NOW = 1_800_000_000_000
const MESSAGES: Message[] = [
  { role: "system", content: "Answer in JSON." },
  { role: "user", content: "Compare Postgres and MySQL for this workload." },
]
const INPUT = encodeRunInput({ messages: MESSAGES, allowDegraded: false, jsonSchema: null })

let dbCounter = 0
let db: FusionDB

beforeEach(() => {
  db = new FusionDB(`fusion-sample-collector-test-${++dbCounter}`)
})

afterEach(async () => {
  db.close()
  await db.delete()
})

function run(runId: string, overrides: Partial<FusionRunRow> = {}): FusionRunRow {
  return {
    runId,
    sessionId: `session-${runId}`,
    surface: "chat",
    origin: "chat",
    mode: "direct",
    actionId: "direct_economy",
    actionHash: "hash-direct",
    ruleId: "R2_economy_simple",
    decisionId: `decision-${runId}`,
    configDigest: "digest",
    status: "succeeded",
    budget: {
      capMicrousd: 1_000_000,
      spentMicrousd: 1_500,
      activeReservationsMicrousd: 0,
      tenantHoldMicrousd: 0,
      overspendMicrousd: 0,
      frozen: false,
      modelCalls: 1,
      maxModelCalls: 24,
      terminal: true,
    },
    budgetMode: "tracked",
    grantMicrousd: 0,
    roleDeployments: {},
    deadlineAt: NOW + 60_000,
    leaseOwner: null,
    leaseExpiresAt: 0,
    fencingToken: 1,
    lastSeq: 2,
    costStatus: "actual",
    inputArtifactId: `input-${runId}`,
    resultArtifactId: null,
    error: null,
    sessionVersion: null,
    actorKeyId: null,
    actorKeyName: null,
    title: null,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    terminalAt: NOW - 5_000,
    ...overrides,
  }
}

function routeDecision(runId: string, selectedActionId: string | null): RouteDecision {
  return {
    schema_version: CONTRACT_SCHEMA_VERSION,
    decision_id: `decision-${runId}`,
    run_id: runId,
    selected_action_id: selectedActionId,
    mode_selected: selectedActionId === null ? null : "direct",
    candidates: [],
    reason_codes: [],
    policy_version: "policy-1",
    registry_version: "registry-1",
    prompt_version: "prompt-1",
    classifier_version: "rules-1",
    degraded: false,
    created_at: "2026-09-15T08:00:00Z",
  }
}

async function seedRun(
  row: FusionRunRow,
  options: { selected?: string | null; decidedAt?: number; decision?: boolean } = {}
): Promise<void> {
  await db.fusionRuns.put(row)
  if (options.decision === false) return
  await db.fusionRouteDecisions.put({
    decisionId: row.decisionId,
    runId: row.runId,
    decision: routeDecision(
      row.runId,
      options.selected === undefined ? row.actionId : options.selected
    ),
    createdAt: options.decidedAt ?? row.createdAt,
  })
}

function event(runId: string, seq: number, type: string, payload: Record<string, unknown> = {}) {
  const row: FusionRunEventRow = { runId, seq, type, payload, createdAt: NOW + seq }
  return row
}

function deps(
  artifacts: Record<string, string | null | Error> = {},
  now = NOW
): CollectRoutingSamplesDeps & { readArtifact: jest.Mock } {
  const readArtifact = jest.fn(async (_runId: string, artifactId: string) => {
    const value = artifactId in artifacts ? artifacts[artifactId] : INPUT
    if (value instanceof Error) throw value
    return value
  })
  return { readArtifact, now: () => now }
}

describe("qualityStatusOf", () => {
  it("is null for a run with no answer", async () => {
    await expect(qualityStatusOf(db, "run-a")).resolves.toBeNull()
    await db.fusionRunEvents.bulkPut([event("run-a", 1, "run.started")])
    await expect(qualityStatusOf(db, "run-a")).resolves.toBeNull()
  })

  it("reads the latest answer's verdict by sequence, ignoring later non-answer events", async () => {
    await db.fusionRunEvents.bulkPut([
      event("run-a", 3, "answer.completed", { quality_status: "accepted" }),
      event("run-a", 1, "answer.completed", { quality_status: "degraded" }),
      event("run-a", 4, "run.succeeded"),
      event("run-b", 9, "answer.completed", { quality_status: "unknown" }),
    ])
    await expect(qualityStatusOf(db, "run-a")).resolves.toBe("accepted")
    await expect(qualityStatusOf(db, "run-b")).resolves.toBe("unknown")
  })

  it("answers null when the latest answer carries no recognised verdict, never an older one", async () => {
    await db.fusionRunEvents.bulkPut([
      event("run-a", 1, "answer.completed", { quality_status: "accepted" }),
      event("run-a", 2, "answer.completed", { quality_status: "excellent" }),
    ])
    await expect(qualityStatusOf(db, "run-a")).resolves.toBeNull()
    await db.fusionRunEvents.put(event("run-b", 1, "answer.completed", {}))
    await expect(qualityStatusOf(db, "run-b")).resolves.toBeNull()
  })
})

describe("collectRoutingSamples", () => {
  it("scans nothing in an empty database", async () => {
    const dependencies = deps()
    await expect(collectRoutingSamples(db, dependencies)).resolves.toEqual({
      scanned: 0,
      collected: 0,
      skipped: [],
    })
    expect(dependencies.readArtifact).not.toHaveBeenCalled()
  })

  it("builds a sample from the run, its decision, its journal and its bill", async () => {
    await seedRun(run("run-a", { budget: { ...run("run-a").budget, spentMicrousd: 1_234.6 } }), {
      decidedAt: NOW - 9_000,
    })
    await db.fusionRunEvents.put(
      event("run-a", 1, "answer.completed", { quality_status: "accepted" })
    )
    const dependencies = deps({}, NOW + 42)

    const result = await collectRoutingSamples(db, dependencies)
    expect(result).toEqual({ scanned: 1, collected: 1, skipped: [] })
    expect(dependencies.readArtifact).toHaveBeenCalledWith("run-a", "input-run-a")

    const [row] = await listRoutingSamples(db)
    expect(row).toEqual({
      sampleId: sampleIdFor("run-a", "decision-run-a"),
      runId: "run-a",
      groupId: "session-run-a",
      actionId: "direct_economy",
      actionHash: "hash-direct",
      mode: "direct",
      ruleId: "R2_economy_simple",
      baselineActionId: "direct_economy",
      featuresVersion: ROUTING_FEATURES_VERSION,
      features: encodeRoutingFeatures(runFeatures(MESSAGES, null)),
      propensity: 1,
      origin: "recorded",
      costMicrousd: 1_235,
      costStatus: "actual",
      accepted: true,
      qualityStatus: "accepted",
      runStatus: "succeeded",
      decidedAt: NOW - 9_000,
      createdAt: NOW + 42,
      expiresAt: routingSampleExpiry(NOW + 42),
    })
  })

  it("re-encodes the stored input with its structured-output schema", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } }
    await seedRun(run("run-a"))
    await collectRoutingSamples(
      db,
      deps({
        "input-run-a": encodeRunInput({
          messages: MESSAGES,
          allowDegraded: true,
          jsonSchema: schema,
        }),
      })
    )
    const [row] = await listRoutingSamples(db)
    expect(row.features).toEqual(encodeRoutingFeatures(runFeatures(MESSAGES, schema)))
  })

  it("reads the B2 bare-array input shape too", async () => {
    await seedRun(run("run-a"))
    const result = await collectRoutingSamples(
      db,
      deps({ "input-run-a": JSON.stringify(MESSAGES) })
    )
    expect(result.collected).toBe(1)
    const [row] = await listRoutingSamples(db)
    expect(row.features).toEqual(encodeRoutingFeatures(runFeatures(MESSAGES, null)))
  })

  it("groups a sessionless run by its own id and never records a negative cost", async () => {
    await seedRun(
      run("run-a", { sessionId: null, budget: { ...run("run-a").budget, spentMicrousd: -50 } })
    )
    await collectRoutingSamples(db, deps())
    const [row] = await listRoutingSamples(db)
    expect(row.groupId).toBe("run-a")
    expect(row.costMicrousd).toBe(0)
  })

  it("labels failed and degraded runs not accepted and keeps their cost (EVAL-03)", async () => {
    await seedRun(run("run-failed", { status: "failed", createdAt: NOW - 3 }))
    await seedRun(run("run-degraded", { createdAt: NOW - 2 }))
    await seedRun(run("run-estimated", { costStatus: "estimated", createdAt: NOW - 1 }))
    await db.fusionRunEvents.bulkPut([
      event("run-failed", 1, "answer.completed", { quality_status: "accepted" }),
      event("run-degraded", 1, "answer.completed", { quality_status: "degraded" }),
    ])

    const result = await collectRoutingSamples(db, deps())
    expect(result).toMatchObject({ scanned: 3, collected: 3, skipped: [] })
    const rows = await listRoutingSamples(db)
    const byRun = new Map(rows.map((row) => [row.runId, row]))
    expect(byRun.get("run-failed")).toMatchObject({
      accepted: false,
      qualityStatus: "accepted",
      runStatus: "failed",
      costMicrousd: 1_500,
    })
    expect(byRun.get("run-degraded")).toMatchObject({ accepted: false, qualityStatus: "degraded" })
    expect(byRun.get("run-estimated")).toMatchObject({
      accepted: false,
      qualityStatus: null,
      costStatus: "estimated",
    })
  })

  it("reports every run it cannot sample, with the reason, and keeps going", async () => {
    let order = 0
    const at = () => NOW - 100 + order++
    await seedRun(run("r-running", { status: "running", costStatus: "pending", createdAt: at() }))
    await seedRun(run("r-queued", { status: "queued", createdAt: at() }))
    await seedRun(run("r-pending", { costStatus: "pending", createdAt: at() }))
    await seedRun(run("r-no-decision", { createdAt: at() }), { decision: false })
    await seedRun(run("r-refused", { createdAt: at() }), { selected: null })
    await seedRun(run("r-other-action", { createdAt: at() }), { selected: "panel_review" })
    await seedRun(run("r-no-input", { inputArtifactId: null, createdAt: at() }))
    await seedRun(run("r-reaped", { createdAt: at() }))
    await seedRun(run("r-locked", { createdAt: at() }))
    await seedRun(run("r-garbled", { createdAt: at() }))
    await seedRun(run("r-empty", { createdAt: at() }))
    await seedRun(run("r-good", { createdAt: at() }))

    const dependencies = deps({
      "input-r-reaped": null,
      "input-r-locked": new Error("vault locked"),
      "input-r-garbled": "{not json",
      "input-r-empty": JSON.stringify({ version: 2, messages: [] }),
    })
    const result = await collectRoutingSamples(db, dependencies)

    expect(result.scanned).toBe(12)
    expect(result.collected).toBe(1)
    expect(result.skipped).toEqual([
      { runId: "r-running", reason: "not_terminal" },
      { runId: "r-queued", reason: "not_terminal" },
      { runId: "r-pending", reason: "cost_pending" },
      { runId: "r-no-decision", reason: "no_decision" },
      { runId: "r-refused", reason: "no_action_selected" },
      { runId: "r-other-action", reason: "no_action_selected" },
      { runId: "r-no-input", reason: "input_unavailable" },
      { runId: "r-reaped", reason: "input_unavailable" },
      { runId: "r-locked", reason: "input_unavailable" },
      { runId: "r-garbled", reason: "input_unavailable" },
      { runId: "r-empty", reason: "input_unavailable" },
    ])
    expect((await listRoutingSamples(db)).map((row) => row.runId)).toEqual(["r-good"])
    // Nothing is read for a run that failed an earlier, cheaper check.
    const readFor = dependencies.readArtifact.mock.calls.map(([runId]) => runId)
    expect(readFor).not.toContain("r-running")
    expect(readFor).not.toContain("r-pending")
    expect(readFor).not.toContain("r-no-decision")
    expect(readFor).not.toContain("r-refused")
    expect(readFor).not.toContain("r-no-input")
  })

  it("writes nothing when no run can be sampled", async () => {
    await seedRun(run("run-a", { status: "running" }))
    await expect(collectRoutingSamples(db, deps())).resolves.toEqual({
      scanned: 1,
      collected: 0,
      skipped: [{ runId: "run-a", reason: "not_terminal" }],
    })
    await expect(countRoutingSamples(db)).resolves.toBe(0)
  })

  it("is idempotent: collecting twice rewrites the same rows", async () => {
    await seedRun(run("run-a", { createdAt: NOW - 2 }))
    await seedRun(run("run-b", { createdAt: NOW - 1 }))
    await collectRoutingSamples(db, deps({}, NOW))
    const first = await listRoutingSamples(db)

    const again = await collectRoutingSamples(db, deps({}, NOW + 1_000))
    expect(again.collected).toBe(2)
    await expect(countRoutingSamples(db)).resolves.toBe(2)
    const second = await listRoutingSamples(db)
    expect(second.map((row) => row.sampleId)).toEqual(first.map((row) => row.sampleId))
    expect(second.map(({ createdAt: _c, expiresAt: _e, ...rest }) => rest)).toEqual(
      first.map(({ createdAt: _c, expiresAt: _e, ...rest }) => rest)
    )
    expect(second[0].createdAt).toBe(NOW + 1_000)
  })

  it("filters on the end time, falling back to the last update for a run with none", async () => {
    await seedRun(run("run-c", { createdAt: NOW - 30, terminalAt: NOW - 1 }))
    await seedRun(run("run-a", { createdAt: NOW - 40, terminalAt: NOW - 500 }))
    await seedRun(run("run-b", { createdAt: NOW - 40, terminalAt: null, updatedAt: NOW - 100 }))
    await seedRun(run("run-d", { createdAt: NOW - 20, terminalAt: NOW }))

    const sinceResult = await collectRoutingSamples(db, deps(), { since: NOW - 100 })
    // run-a ended before the window; run-b has no terminal time and falls back to updatedAt (inclusive).
    expect(sinceResult.scanned).toBe(3)
    expect((await listRoutingSamples(db)).map((row) => row.runId).sort()).toEqual([
      "run-b",
      "run-c",
      "run-d",
    ])
  })

  it("applies the limit after ordering by creation time then run id", async () => {
    await seedRun(run("run-c", { createdAt: NOW - 10 }))
    await seedRun(run("run-b", { createdAt: NOW - 20 }))
    await seedRun(run("run-a", { createdAt: NOW - 20 }))
    const dependencies = deps()
    const result = await collectRoutingSamples(db, dependencies, { limit: 2 })
    expect(result).toMatchObject({ scanned: 2, collected: 2 })
    expect(dependencies.readArtifact.mock.calls.map(([runId]) => runId)).toEqual(["run-a", "run-b"])
    await expect(countRoutingSamples(db)).resolves.toBe(2)
  })

  it("applies the limit to the runs inside the window, not to every run", async () => {
    await seedRun(run("run-a", { createdAt: NOW - 20, terminalAt: NOW - 500 }))
    await seedRun(run("run-b", { createdAt: NOW - 20, terminalAt: NOW }))
    await seedRun(run("run-c", { createdAt: NOW - 10, terminalAt: NOW + 1 }))
    await seedRun(run("run-d", { createdAt: NOW - 5, terminalAt: NOW + 2 }))
    const dependencies = deps()
    const result = await collectRoutingSamples(db, dependencies, { since: NOW, limit: 2 })
    expect(result.scanned).toBe(2)
    expect(dependencies.readArtifact.mock.calls.map(([runId]) => runId)).toEqual(["run-b", "run-c"])
  })
})
