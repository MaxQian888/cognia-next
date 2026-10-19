/** @jest-environment jsdom */
/**
 * Tests for lib/db/harness-evolution.ts — Harness Evolution persistence
 * (ADR-0237): content-addressed snapshots, run dedupe, compare-and-swap writes,
 * leases, steps by cache key, experiences, and retention.
 *
 * Dexie runs on fake-indexeddb via createDbTestFixture.
 */

import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  HarnessRunConflictError,
  claimHarnessRunLease,
  createHarnessRun,
  deleteHarnessRun,
  findHarnessSnapshotByHash,
  getHarnessExperience,
  getHarnessRun,
  getHarnessSnapshot,
  getHarnessSnapshots,
  getHarnessStep,
  listHarnessExperiences,
  listHarnessRuns,
  listHarnessSnapshots,
  listHarnessSteps,
  listOpenHarnessRuns,
  listOrphanedHarnessRuns,
  listRolloutsByCacheKey,
  pruneHarnessHistory,
  putHarnessExperience,
  putHarnessSnapshot,
  putHarnessStep,
  releaseHarnessRunLease,
  saveHarnessRun,
  updateHarnessExperience,
  deleteHarnessExperience,
} from "./harness-evolution"
import { emptyLedger } from "@/lib/harness/budget"
import { transitionRun } from "@/lib/harness/machine"
import { makeComponents, makeTask } from "@/lib/harness/test-fixtures"
import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function snapshot(id: string, overrides: Partial<HarnessSnapshotV1> = {}): HarnessSnapshotV1 {
  return {
    schemaVersion: 1,
    id,
    contentHash: `hash-${id}`,
    characterId: "agent-1",
    characterName: "Analyst",
    scope: "session",
    components: makeComponents(),
    execution: {},
    runtimeFingerprint: "hrf1-x",
    origin: { kind: "captured" },
    createdAt: 1,
    ...overrides,
  } as HarnessSnapshotV1
}

function run(id: string, overrides: Partial<HarnessEvolutionRun> = {}): HarnessEvolutionRun {
  return {
    id,
    characterId: "agent-1",
    characterName: "Analyst",
    trigger: "manual",
    task: makeTask(),
    config: {
      mode: "parallel",
      k: 1,
      scope: "session",
      editable: ["memory"],
      models: {},
      budget: {
        maxIterations: 1,
        maxCandidates: 2,
        maxParallelRuns: 1,
        maxModelCalls: 10,
        maxTokens: 100_000,
        maxCostUsd: 1,
        maxWallTimeMs: 600_000,
        maxTurnsPerRollout: 10,
      },
      autoAdoptLowRisk: false,
      useExperiences: true,
      editorChannel: "auto",
      probe: { allowedMcpServerIds: [], networkOff: true },
      seed: 1,
    },
    status: "queued",
    round: 0,
    finalLabels: [],
    experienceIds: [],
    ledger: emptyLedger(),
    dedupeKey: `dedupe-${id}`,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function step(
  runId: string,
  label: string,
  overrides: Partial<HarnessEvolutionStep> = {}
): HarnessEvolutionStep {
  return {
    id: `${runId}:${label}`,
    runId,
    label,
    kind: "rollout",
    status: "succeeded",
    attempts: 1,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    updatedAt: 1,
    ...overrides,
  }
}

function experience(id: string, overrides: Partial<HarnessExperience> = {}): HarnessExperience {
  return {
    id,
    scope: "agent",
    characterId: "agent-1",
    domain: "office/reports",
    problemPattern: "CSV with ; separators",
    lesson: "memory.md: state the separator",
    evidenceSummary: "base failed to parse; dom1 parsed",
    confidence: "medium",
    applicableConditions: [],
    excludedConditions: [],
    components: ["memory"],
    edits: [],
    baseSnapshotId: "snap-base",
    evidenceRefs: [],
    sourceRunId: "run-1",
    changeSummary: "added a fact",
    observedBenefits: [],
    knownLimitations: [],
    validationStatus: "proposed",
    runtimeFingerprint: "hrf1-x",
    tags: [],
    supportRunIds: [],
    conflictsWith: [],
    retrievedCount: 0,
    helpedCount: 0,
    hurtCount: 0,
    disabled: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("snapshots", () => {
  it("stores, lists newest first and finds by content hash", async () => {
    await putHarnessSnapshot(snapshot("s1", { createdAt: 1 }))
    await putHarnessSnapshot(snapshot("s2", { createdAt: 2, contentHash: "same" }))
    await putHarnessSnapshot(snapshot("s3", { createdAt: 3, contentHash: "same" }))
    await putHarnessSnapshot(
      snapshot("other", { characterId: "agent-2", contentHash: "same", createdAt: 9 })
    )
    expect((await getHarnessSnapshot("s1"))?.components.memory).toBe(makeComponents().memory)
    expect((await listHarnessSnapshots("agent-1")).map((s) => s.id)).toEqual(["s3", "s2", "s1"])
    expect((await findHarnessSnapshotByHash("agent-1", "same"))?.id).toBe("s3")
    expect(await findHarnessSnapshotByHash("agent-1", "none")).toBeUndefined()
    expect([...(await getHarnessSnapshots(["s1", "s1", "missing"])).keys()]).toEqual(["s1"])
  })
})

describe("runs", () => {
  it("dedupes an unfinished run with the same key", async () => {
    const first = await createHarnessRun(run("r1", { dedupeKey: "k" }))
    expect(first.created).toBe(true)
    const again = await createHarnessRun(run("r2", { dedupeKey: "k" }))
    expect(again).toEqual({ created: false, run: expect.objectContaining({ id: "r1" }) })
    await saveHarnessRun(transitionRun(first.run, "cancelled", {}, 5), 1)
    expect((await createHarnessRun(run("r3", { dedupeKey: "k" }))).created).toBe(true)
  })

  it("writes only through compare-and-swap", async () => {
    const { run: created } = await createHarnessRun(run("r1"))
    const next = transitionRun(created, "snapshotting", {}, 2)
    await saveHarnessRun(next, 1)
    await expect(
      saveHarnessRun(transitionRun(created, "cancelled", {}, 3), 1)
    ).rejects.toBeInstanceOf(HarnessRunConflictError)
    await expect(saveHarnessRun({ ...next }, 2)).rejects.toThrow(/must raise version/)
    await expect(saveHarnessRun(run("missing", { version: 2 }), 1)).rejects.toThrow(
      /does not exist/
    )
    expect((await getHarnessRun("r1"))?.status).toBe("snapshotting")
  })

  it("lists runs per agent and open runs", async () => {
    await createHarnessRun(run("r1", { createdAt: 1 }))
    await createHarnessRun(run("r2", { createdAt: 2 }))
    await createHarnessRun(run("r3", { characterId: "agent-2", createdAt: 3, status: "completed" }))
    expect((await listHarnessRuns({ characterId: "agent-1" })).map((r) => r.id)).toEqual([
      "r2",
      "r1",
    ])
    expect((await listHarnessRuns()).length).toBe(3)
    expect((await listOpenHarnessRuns()).map((r) => r.id).sort()).toEqual(["r1", "r2"])
  })

  it("grants a lease to one owner at a time and lets it lapse", async () => {
    await createHarnessRun(run("r1", { status: "probing" }))
    const claimed = await claimHarnessRunLease("r1", "a", 1_000, 10)
    expect(claimed?.owner).toEqual({ ownerId: "a", leaseExpiresAt: 1_010 })
    expect(await claimHarnessRunLease("r1", "b", 1_000, 20)).toBeNull()
    expect((await claimHarnessRunLease("r1", "a", 1_000, 500))?.owner?.leaseExpiresAt).toBe(1_500)
    expect(await listOrphanedHarnessRuns(600)).toEqual([])
    expect((await listOrphanedHarnessRuns(2_000)).map((r) => r.id)).toEqual(["r1"])
    expect((await claimHarnessRunLease("r1", "b", 1_000, 2_000))?.owner?.ownerId).toBe("b")
    await releaseHarnessRunLease("r1", "a")
    expect((await getHarnessRun("r1"))?.owner?.ownerId).toBe("b")
    await releaseHarnessRunLease("r1", "b")
    expect((await getHarnessRun("r1"))?.owner).toBeUndefined()
    await createHarnessRun(run("done", { status: "completed" }))
    expect(await claimHarnessRunLease("done", "a", 1_000, 1)).toBeNull()
  })

  it("deletes a run with its steps", async () => {
    await createHarnessRun(run("r1"))
    await putHarnessStep(step("r1", "base1"))
    await deleteHarnessRun("r1")
    expect(await getHarnessRun("r1")).toBeUndefined()
    expect(await listHarnessSteps("r1")).toEqual([])
  })
})

describe("steps", () => {
  it("lists a run's steps in start order and finds rollouts by cache key", async () => {
    await putHarnessStep(step("r1", "inv1", { startedAt: 5, cacheKey: "k1" }))
    await putHarnessStep(step("r1", "base1", { startedAt: 1, cacheKey: "k1" }))
    await putHarnessStep(step("r2", "base1", { startedAt: 1, cacheKey: "k2" }))
    expect((await listHarnessSteps("r1")).map((s) => s.label)).toEqual(["base1", "inv1"])
    expect((await listRolloutsByCacheKey("k1")).length).toBe(2)
    expect((await getHarnessStep("r2:base1"))?.cacheKey).toBe("k2")
  })
})

describe("experiences", () => {
  it("filters by agent, domain, status and disabled", async () => {
    await putHarnessExperience(experience("e1", { updatedAt: 1 }))
    await putHarnessExperience(experience("e2", { updatedAt: 2, validationStatus: "verified" }))
    await putHarnessExperience(experience("e3", { updatedAt: 3, disabled: true }))
    await putHarnessExperience(experience("e4", { characterId: "agent-2", domain: "coding" }))
    expect((await listHarnessExperiences({ characterId: "agent-1" })).map((e) => e.id)).toEqual([
      "e2",
      "e1",
    ])
    expect(
      (await listHarnessExperiences({ characterId: "agent-1", includeDisabled: true })).map(
        (e) => e.id
      )
    ).toEqual(["e3", "e2", "e1"])
    expect((await listHarnessExperiences({ statuses: ["verified"] })).map((e) => e.id)).toEqual([
      "e2",
    ])
    expect((await listHarnessExperiences({ domain: "coding" })).map((e) => e.id)).toEqual(["e4"])
  })

  it("updates in place and deletes", async () => {
    await putHarnessExperience(experience("e1"))
    const updated = await updateHarnessExperience("e1", (e) => ({
      ...e,
      helpedCount: e.helpedCount + 1,
    }))
    expect(updated?.helpedCount).toBe(1)
    expect(await updateHarnessExperience("missing", (e) => e)).toBeUndefined()
    await deleteHarnessExperience("e1")
    expect(await getHarnessExperience("e1")).toBeUndefined()
  })
})

describe("pruneHarnessHistory", () => {
  it("keeps the newest finished runs, adopted runs and everything they reference", async () => {
    await putHarnessSnapshot(snapshot("root"))
    await putHarnessSnapshot(snapshot("adopted", { parentId: "root" }))
    await putHarnessSnapshot(snapshot("old-base"))
    await putHarnessSnapshot(snapshot("old-cand", { parentId: "old-base" }))
    await putHarnessSnapshot(snapshot("new-base"))
    await putHarnessSnapshot(snapshot("exp-base"))
    await putHarnessSnapshot(snapshot("orphan"))
    await putHarnessSnapshot(snapshot("other-agent", { characterId: "agent-2" }))

    await createHarnessRun(
      run("adopted-run", {
        status: "completed",
        createdAt: 1,
        baseSnapshotId: "root",
        adoption: { scope: "session", adoptedAt: 1 },
      })
    )
    await createHarnessRun(
      run("old", { status: "completed", createdAt: 2, baseSnapshotId: "old-base" })
    )
    await putHarnessStep(step("old", "inv1", { snapshotId: "old-cand" }))
    await createHarnessRun(
      run("new", { status: "failed", createdAt: 3, baseSnapshotId: "new-base" })
    )
    await createHarnessRun(run("open", { status: "probing", createdAt: 0 }))
    await putHarnessExperience(experience("e1", { baseSnapshotId: "exp-base" }))
    await getDb().characters.put({
      id: "agent-1",
      name: "Analyst",
      harness: { adoptedSnapshotId: "adopted" },
    } as never)

    const result = await pruneHarnessHistory("agent-1", 1)
    expect(result).toEqual({ runsDeleted: 1, snapshotsDeleted: 3 })
    expect((await listHarnessRuns({ characterId: "agent-1" })).map((r) => r.id).sort()).toEqual([
      "adopted-run",
      "new",
      "open",
    ])
    expect(await listHarnessSteps("old")).toEqual([])
    const left = (await listHarnessSnapshots("agent-1")).map((s) => s.id).sort()
    expect(left).toEqual(["adopted", "exp-base", "new-base", "root"])
    expect(await getHarnessSnapshot("other-agent")).toBeDefined()
  })
})
