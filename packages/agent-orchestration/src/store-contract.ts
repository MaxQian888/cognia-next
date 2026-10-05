/**
 * The behavior every {@link TeamRunStore} must show (ADR-0217).
 *
 * Framework-neutral: a test suite iterates the cases and supplies a fresh
 * store and three assertions. The orchestration package runs it against the
 * memory store; the app runs it against its Dexie store, so the two can never
 * drift apart.
 */

import type {
  AgentTeamChildRun,
  AgentTeamDecision,
  AgentTeamEvidence,
  AgentTeamRunRecord,
  AgentTeamSteeringReceipt,
} from "./records"
import type { TeamRunStore } from "./store"

export interface StoreContractAssert {
  /** Deep equality. */
  equal(actual: unknown, expected: unknown): void
  ok(value: unknown, message?: string): void
  rejects(promise: Promise<unknown>, message: RegExp): Promise<void>
}

export interface StoreContractCase {
  name: string
  run(store: TeamRunStore, assert: StoreContractAssert): Promise<void>
}

export function contractRun(overrides: Partial<AgentTeamRunRecord> = {}): AgentTeamRunRecord {
  return {
    id: "run-1",
    teamId: "team-1",
    objective: "Ship the feature",
    status: "running",
    priority: 0,
    decisionVersion: 0,
    resourceUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      wallTimeMs: 0,
      toolTimeMs: 0,
      attempts: 0,
      failures: 0,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

export function contractChild(overrides: Partial<AgentTeamChildRun> = {}): AgentTeamChildRun {
  return {
    id: "child-1",
    runId: "run-1",
    teamId: "team-1",
    teammateId: "mate-1",
    taskId: "task-1",
    repositoryId: "repo-1",
    status: "running",
    attempt: 1,
    decisionVersion: 0,
    resourceUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      wallTimeMs: 0,
      toolTimeMs: 0,
      attempts: 0,
      failures: 0,
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function evidence(overrides: Partial<AgentTeamEvidence> = {}): AgentTeamEvidence {
  return {
    id: "evidence-1",
    runId: "run-1",
    childRunId: "child-1",
    taskId: "task-1",
    attempt: 1,
    kind: "test",
    title: "unit tests",
    status: "passed",
    createdAt: 10,
    ...overrides,
  }
}

function decision(overrides: Partial<AgentTeamDecision> = {}): AgentTeamDecision {
  return {
    id: "decision-1",
    runId: "run-1",
    version: 1,
    status: "proposed",
    title: "Use the port",
    detail: "Reach run state through the store",
    authorId: "mate-1",
    evidenceIds: [],
    immutable: false,
    createdAt: 10,
    ...overrides,
  }
}

function receipt(overrides: Partial<AgentTeamSteeringReceipt> = {}): AgentTeamSteeringReceipt {
  return {
    id: "steer-1",
    runId: "run-1",
    childRunId: "child-1",
    message: "focus on tests",
    status: "queued",
    createdAt: 5,
    updatedAt: 5,
    ...overrides,
  }
}

export const TEAM_RUN_STORE_CONTRACT: readonly StoreContractCase[] = [
  {
    name: "creates, reads and patches runs; refuses a run without its identity",
    async run(store, assert) {
      await store.createRun(contractRun())
      assert.equal((await store.getRun("run-1"))?.objective, "Ship the feature")
      assert.equal(await store.updateRun("run-1", { status: "paused", updatedAt: 2 }), true)
      assert.equal((await store.getRun("run-1"))?.status, "paused")
      assert.equal(await store.updateRun("missing", { status: "paused" }), false)
      await assert.rejects(
        store.createRun(contractRun({ id: "run-2", objective: "  " })),
        /objective/
      )
    },
  },
  {
    name: "compare-and-set updates only while the control state is unchanged",
    async run(store, assert) {
      await store.createRun(contractRun())
      const run = (await store.getRun("run-1"))!
      assert.equal(
        await store.updateRunIfCurrent("run-1", run, { status: "paused", updatedAt: 2 }),
        true
      )
      // The stale expectation (old status/updatedAt) no longer matches.
      assert.equal(
        await store.updateRunIfCurrent("run-1", run, { status: "failed", updatedAt: 3 }),
        false
      )
      assert.equal((await store.getRun("run-1"))?.status, "paused")
      await store.createChild(contractChild())
      const child = (await store.getChild("child-1"))!
      assert.equal(await store.updateChildIfCurrent("child-1", child, { updatedAt: 9 }), true)
      assert.equal(await store.updateChildIfCurrent("child-1", child, { updatedAt: 10 }), false)
    },
  },
  {
    name: "lists runs newest first and recovery candidates by priority then queue order",
    async run(store, assert) {
      await store.createRun(contractRun({ id: "a", updatedAt: 1, status: "running", priority: 0 }))
      await store.createRun(
        contractRun({ id: "b", updatedAt: 3, status: "recovering", priority: 5, createdAt: 2 })
      )
      await store.createRun(contractRun({ id: "c", updatedAt: 2, status: "paused" }))
      await store.createRun(
        contractRun({ id: "d", updatedAt: 4, status: "pausing", priority: 5, createdAt: 1 })
      )
      await store.createRun(contractRun({ id: "e", teamId: "team-2", updatedAt: 5 }))
      assert.equal(
        (await store.listRuns()).map((run) => run.id),
        ["e", "d", "b", "c", "a"]
      )
      assert.equal(
        (await store.listRuns("team-2")).map((run) => run.id),
        ["e"]
      )
      assert.equal(
        (await store.listRecoveryCandidates()).map((run) => run.id),
        ["d", "b", "a", "e"]
      )
    },
  },
  {
    name: "lists children oldest first and finds a teammate's newest child for a task",
    async run(store, assert) {
      await store.createChild(contractChild({ id: "c1", createdAt: 1, updatedAt: 1 }))
      await store.createChild(contractChild({ id: "c2", createdAt: 2, updatedAt: 5 }))
      await store.createChild(contractChild({ id: "c3", createdAt: 3, teammateId: "other" }))
      assert.equal(
        (await store.listChildren("run-1")).map((child) => child.id),
        ["c1", "c2", "c3"]
      )
      assert.equal((await store.findLatestChild("run-1", "task-1", "mate-1"))?.id, "c2")
      assert.equal(await store.findLatestChild("run-1", "task-9", "mate-1"), undefined)
      await assert.rejects(
        store.createChild(contractChild({ id: "c4", repositoryId: "" })),
        /repository/
      )
    },
  },
  {
    name: "a dispatch lease admits one holder until it expires, and renews or settles only for it",
    async run(store, assert) {
      await store.createChild(contractChild({ waitingReason: "scheduler_admission" }))
      const claimed = await store.claimDispatchLease({
        childRunId: "child-1",
        leaseId: "L1",
        hostRef: "host-a",
        now: 100,
        ttlMs: 1_000,
      })
      assert.equal(claimed?.dispatchLeaseId, "L1")
      assert.equal(claimed?.dispatchLeaseExpiresAt, 1_100)
      assert.equal(claimed?.waitingReason, undefined)
      // Same lease: idempotent replay.
      assert.ok(
        await store.claimDispatchLease({
          childRunId: "child-1",
          leaseId: "L1",
          hostRef: "host-a",
          now: 200,
        })
      )
      // Another lease while L1 is live: refused.
      assert.equal(
        await store.claimDispatchLease({
          childRunId: "child-1",
          leaseId: "L2",
          hostRef: "host-b",
          now: 300,
          ttlMs: 1_000,
        }),
        undefined
      )
      assert.equal(await store.renewDispatchLease("child-1", "L2", 400), false)
      assert.equal(await store.renewDispatchLease("child-1", "L1", 400, 1_000), true)
      assert.equal((await store.getChild("child-1"))?.dispatchLeaseExpiresAt, 1_400)
      // Expired: another host may take it over.
      const taken = await store.claimDispatchLease({
        childRunId: "child-1",
        leaseId: "L2",
        hostRef: "host-b",
        now: 5_000,
      })
      assert.equal(taken?.hostRef, "host-b")
      assert.equal(await store.settleDispatchLease("child-1", "L1", 5_100), false)
      assert.equal(await store.settleDispatchLease("child-1", "L2", 5_100), true)
      assert.equal((await store.getChild("child-1"))?.dispatchLeaseId, undefined)
      assert.equal(
        await store.claimDispatchLease({
          childRunId: "missing",
          leaseId: "L",
          hostRef: "h",
          now: 1,
        }),
        undefined
      )
    },
  },
  {
    name: "remote events advance in order, record once, and never cross runs",
    async run(store, assert) {
      await store.createChild(contractChild())
      const envelope = { runId: "run-1", event: { type: "progress", n: 1 } }
      assert.equal(await store.advanceRemoteEvent("child-1", undefined, "e1", 10, envelope), true)
      // Replaying from the same cursor is a duplicate.
      assert.equal(await store.advanceRemoteEvent("child-1", undefined, "e1", 11, envelope), false)
      assert.equal(await store.advanceRemoteEvent("child-1", "e1", "e2", 12), true)
      assert.equal((await store.getChild("child-1"))?.lastRemoteEventId, "e2")
      const events = await store.listTrajectory("run-1")
      assert.equal(
        events.map((event) => [event.kind, event.correlationId]),
        [["remote_event", "e1"]]
      )
      const stored = await store.getContent(events[0]!.contentHash!)
      assert.equal(stored?.mimeType, "application/json")
      await assert.rejects(
        store.advanceRemoteEvent("child-1", "e2", "e3", 13, { runId: "run-9", event: {} }),
        /another run/
      )
    },
  },
  {
    name: "the trajectory is monotonic per run and records the child's last sequence",
    async run(store, assert) {
      await store.createChild(contractChild())
      const first = await store.appendTrajectory({
        runId: "run-1",
        childRunId: "child-1",
        kind: "model_turn_started",
        correlationId: "turn-1",
        createdAt: 20,
      })
      const second = await store.appendTrajectory(
        { runId: "run-1", kind: "model_turn_completed", correlationId: "turn-1", createdAt: 21 },
        { data: "hello", mimeType: "text/plain" }
      )
      await store.appendTrajectory({
        runId: "run-2",
        kind: "model_turn_started",
        correlationId: "turn-2",
        createdAt: 22,
      })
      assert.equal([first.sequence, first.id], [1, "run-1:1"])
      assert.equal([second.sequence, second.id], [2, "run-1:2"])
      assert.ok(second.contentHash?.startsWith("sha256:"), "content is hashed")
      assert.equal((await store.getContent(second.contentHash!))?.byteLength, 5)
      assert.equal((await store.getChild("child-1"))?.lastTrajectorySequence, 1)
      assert.equal(
        (await store.listTrajectory("run-1", 1)).map((event) => event.sequence),
        [2]
      )
      assert.equal((await store.listTrajectory("run-2")).length, 1)
    },
  },
  {
    name: "checkpoints are found newest first and stamp the child",
    async run(store, assert) {
      await store.createChild(contractChild())
      await store.markCheckpoint({
        runId: "run-1",
        childRunId: "child-1",
        trajectorySequence: 1,
        decisionVersion: 0,
        replay: "safe",
        sideEffects: [],
        createdAt: 30,
      })
      const latest = await store.markCheckpoint({
        runId: "run-1",
        childRunId: "child-1",
        trajectorySequence: 4,
        decisionVersion: 0,
        replay: "needs_input",
        sideEffects: [],
        createdAt: 31,
      })
      assert.equal((await store.getLatestCheckpoint("child-1"))?.id, latest.id)
      const child = await store.getChild("child-1")
      assert.equal([child?.lastCheckpointId, child?.lastTrajectorySequence], [latest.id, 4])
      assert.equal(await store.getLatestCheckpoint("missing"), undefined)
    },
  },
  {
    name: "steering keeps the child's pending count and lists what is still pending",
    async run(store, assert) {
      await store.createChild(contractChild())
      await store.createSteeringReceipt(receipt())
      await store.createSteeringReceipt(receipt({ id: "steer-2", createdAt: 6, updatedAt: 6 }))
      assert.equal((await store.getChild("child-1"))?.pendingSteeringCount, 2)
      assert.equal(await store.updateSteeringReceipt("steer-1", "delivered", 7), true)
      assert.equal((await store.getChild("child-1"))?.pendingSteeringCount, 2)
      assert.equal(await store.updateSteeringReceipt("steer-1", "applied", 8), true)
      assert.equal(await store.updateSteeringReceipt("steer-2", "rejected", 9, "obsolete"), true)
      assert.equal((await store.getChild("child-1"))?.pendingSteeringCount, 0)
      assert.equal(await store.listPendingSteering("child-1"), [])
      const all = await store.listSteeringReceipts("run-1")
      assert.equal(
        all.map((row) => [row.id, row.status, row.appliedAt, row.reason]),
        [
          ["steer-1", "applied", 8, undefined],
          ["steer-2", "rejected", undefined, "obsolete"],
        ]
      )
      assert.equal(await store.updateSteeringReceipt("missing", "applied", 1), false)
    },
  },
  {
    name: "an atomic block commits together or not at all",
    async run(store, assert) {
      await store.createRun(contractRun())
      await assert.rejects(
        store.atomically(async (tx) => {
          await tx.updateRun("run-1", { status: "paused", updatedAt: 2 })
          await tx.createChild(contractChild())
          throw new Error("abort the unit")
        }),
        /abort the unit/
      )
      assert.equal((await store.getRun("run-1"))?.status, "running")
      assert.equal(await store.getChild("child-1"), undefined)
      const committed = await store.atomically(async (tx) => {
        await tx.updateRun("run-1", { status: "paused", updatedAt: 3 })
        await tx.createChild(contractChild())
        return "done"
      })
      assert.equal(committed, "done")
      assert.equal((await store.getRun("run-1"))?.status, "paused")
      assert.ok(await store.getChild("child-1"), "child committed with the run")
    },
  },
  {
    name: "atomic blocks do not interleave their read-modify-write",
    async run(store, assert) {
      await store.createRun(contractRun({ decisionVersion: 0 }))
      const bump = () =>
        store.atomically(async (tx) => {
          const run = await tx.getRun("run-1")
          await Promise.resolve()
          await tx.updateRun("run-1", { decisionVersion: (run?.decisionVersion ?? 0) + 1 })
        })
      await Promise.all([bump(), bump(), bump()])
      assert.equal((await store.getRun("run-1"))?.decisionVersion, 3)
    },
  },
  {
    name: "stores evidence with its content, lists it by scope oldest first",
    async run(store, assert) {
      const stored = await store.putEvidence(evidence({ createdAt: 20 }), {
        data: "PASS 12 tests",
        mimeType: "text/plain",
      })
      assert.ok(stored.contentHash, "stored evidence references its content")
      const content = await store.getContent(stored.contentHash!)
      assert.equal(new TextDecoder().decode(content?.data), "PASS 12 tests")
      await store.putEvidence(evidence({ id: "evidence-0", kind: "activity", createdAt: 15 }))
      await store.putEvidence(evidence({ id: "evidence-2", attempt: 2, createdAt: 30 }))
      await store.putEvidence(evidence({ id: "evidence-other-task", taskId: "task-2" }))
      await store.putEvidence(evidence({ id: "evidence-other-run", runId: "run-2" }))
      const ids = (rows: AgentTeamEvidence[]) => rows.map((row) => row.id)
      assert.equal(ids(await store.listEvidence("run-1", { taskId: "task-1" })), [
        "evidence-0",
        "evidence-1",
        "evidence-2",
      ])
      assert.equal(ids(await store.listEvidence("run-1", { childRunId: "child-1", attempt: 2 })), [
        "evidence-2",
      ])
      assert.equal(ids(await store.listEvidence("run-1")), [
        "evidence-other-task",
        "evidence-0",
        "evidence-1",
        "evidence-2",
      ])
      assert.equal(
        (await store.getEvidence(["evidence-2", "missing"])).map((row) => row?.id),
        ["evidence-2", undefined]
      )
    },
  },
  {
    name: "keeps decisions in version order and refuses a mutable user constraint",
    async run(store, assert) {
      await store.putDecision(decision({ id: "d-2", version: 2, createdAt: 5 }))
      await store.putDecision(
        decision({ id: "d-c", version: 0, status: "constraint", immutable: true })
      )
      await store.putDecision(decision({ id: "d-1b", version: 1, createdAt: 9 }))
      await store.putDecision(decision({ id: "d-1a", version: 1, createdAt: 3 }))
      await store.putDecision(decision({ id: "d-elsewhere", runId: "run-2" }))
      assert.equal(
        (await store.listDecisions("run-1")).map((row) => row.id),
        ["d-c", "d-1a", "d-1b", "d-2"]
      )
      await store.putDecision(decision({ id: "d-2", version: 2, status: "accepted" }))
      assert.equal((await store.getDecision("d-2"))?.status, "accepted")
      await assert.rejects(
        store.putDecision(decision({ id: "d-bad", status: "constraint", immutable: false })),
        /immutable/
      )
      assert.equal(await store.getDecision("d-bad"), undefined)
    },
  },
  {
    name: "an atomic block spans decisions and evidence with the run",
    async run(store, assert) {
      await store.createRun(contractRun())
      await store.putEvidence(evidence())
      await assert.rejects(
        store.atomically(async (tx) => {
          assert.equal((await tx.getEvidence(["evidence-1"]))[0]?.id, "evidence-1")
          await tx.putDecision(decision({ status: "accepted", immutable: true }))
          await tx.updateRun("run-1", { decisionVersion: 1, updatedAt: 2 })
          throw new Error("abort the acceptance")
        }),
        /abort the acceptance/
      )
      assert.equal(await store.getDecision("decision-1"), undefined)
      assert.equal((await store.getRun("run-1"))?.decisionVersion, 0)
      await store.atomically(async (tx) => {
        await tx.putDecision(decision({ status: "accepted", immutable: true }))
        await tx.updateRun("run-1", { decisionVersion: 1, updatedAt: 3 })
        assert.equal((await tx.listDecisions("run-1")).length, 1)
      })
      assert.equal((await store.getDecision("decision-1"))?.status, "accepted")
      assert.equal((await store.getRun("run-1"))?.decisionVersion, 1)
    },
  },
]
