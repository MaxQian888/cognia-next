/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { ExecutionRunInterrupt } from "@/types/execution/run"
import {
  ALL_RECOVERY_CHOICES,
  LEGACY_RECOVERY_CHOICES,
  applyTeamRecoveryDecision,
  applyTeamRecoveryFromControl,
  armPendingTeamRecoveries,
  ensureTeamRecoveryInterrupt,
  type TeamRecoveryDeps,
} from "./team-recovery"
import { createSquadRunRecords } from "../squad/squad-run-records"
import { createDurableTeamCoordinator } from "./durable-runtime"
import { controlSquadRun } from "../squad/squad-control"
import { startSquadRun } from "../squad/start-squad-run"

const RUN = "run_team_rec01"
const EXECUTION = `execution:team:${RUN}`

async function seedParkedRun(recoveryReason = "uncertain_side_effect") {
  await createSquadRunRecords({
    runId: RUN,
    teamId: "team-1",
    objective: "o",
    origin: "chat",
    executionConstraints: {
      version: 1,
      teamConfig: {},
      origin: "chat",
      triggeredFrom: { source: "ui" },
      requirePlanApprovalFloor: true,
    },
    projectId: "ws-1",
    startedAt: 1_000,
  })
  await getDb().agentTeamRuns.update(RUN, { status: "needs_input", recoveryReason })
}

async function seedInterrupt(
  id: string,
  status: ExecutionRunInterrupt["status"],
  subject?: Record<string, unknown>
) {
  await getDb().executionRunInterrupts.add({
    id,
    runId: EXECUTION,
    type: "team_recovery",
    status,
    title: "recovery",
    reviewKind: "team_recovery",
    ...(subject ? { subject } : {}),
    createdAt: 1,
    expiresAt: 10_000_000,
  } as ExecutionRunInterrupt)
}

function harness(over: Partial<TeamRecoveryDeps> = {}) {
  const armed: Array<{ instance: string; subject: Record<string, unknown> }> = []
  const retried: Array<[string, string | undefined]> = []
  const controlled: Array<[string, string]> = []
  const deps: TeamRecoveryDeps = {
    arm: async (input) => {
      armed.push({ instance: input.instance, subject: input.subject })
      return { interruptId: `int-${input.instance}`, pending: true }
    },
    retryChild: async (childId, hostRef) => {
      retried.push([childId, hostRef])
    },
    control: async (runId, action) => {
      controlled.push([runId, action])
      return { ok: true }
    },
    startReplacement: async () => ({ started: true, executionRunId: "execution:team:run_new" }),
    listChildren: async () => [
      { id: "c1", status: "running", hostRef: "host-a" },
      { id: "c2", status: "running", hostRef: "host-a" },
    ],
    assessReplay: async () => ({ safe: false, uncertainChildIds: ["c1", "c2"] }),
    ...over,
  }
  return { deps, armed, retried, controlled }
}

describe("team recovery", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  describe("ensureTeamRecoveryInterrupt", () => {
    it("raises a first recovery with every choice and the uncertain children", async () => {
      await seedParkedRun()
      const h = harness()
      const result = await ensureTeamRecoveryInterrupt(RUN, h.deps)
      expect(result).toEqual({ interruptId: "int-r1", pending: true })
      expect(h.armed).toEqual([
        {
          instance: "r1",
          subject: {
            reason: "uncertain_side_effect",
            choices: [...ALL_RECOVERY_CHOICES],
            uncertainChildIds: ["c1", "c2"],
            hostRef: "host-a",
          },
        },
      ])
    })

    it("offers a legacy run only restart or terminate, and reads no children", async () => {
      await seedParkedRun("legacy_run_not_resumable")
      const listChildren = jest.fn(async () => [])
      const h = harness({ listChildren })
      await ensureTeamRecoveryInterrupt(RUN, h.deps)
      expect(listChildren).not.toHaveBeenCalled()
      expect(h.armed[0]?.subject).toMatchObject({
        reason: "legacy_run_not_resumable",
        choices: [...LEGACY_RECOVERY_CHOICES],
        uncertainChildIds: [],
      })
    })

    it("offers a Squad that is not ready restart or terminate only", async () => {
      await seedParkedRun("squad_not_ready")
      const h = harness()
      await ensureTeamRecoveryInterrupt(RUN, h.deps)
      expect(h.armed[0]?.subject).toMatchObject({
        reason: "squad_not_ready",
        choices: [...LEGACY_RECOVERY_CHOICES],
        uncertainChildIds: [],
      })
    })

    it("returns the pending recovery instead of raising a second", async () => {
      await seedParkedRun()
      await seedInterrupt("int-open", "pending")
      const h = harness()
      const result = await ensureTeamRecoveryInterrupt(RUN, h.deps)
      expect(result).toEqual({ interruptId: "int-open", pending: true })
      expect(h.armed).toEqual([])
    })

    it("raises a fresh instance after an earlier recovery was answered", async () => {
      await seedParkedRun()
      await seedInterrupt("int-old", "approved")
      const h = harness()
      await ensureTeamRecoveryInterrupt(RUN, h.deps)
      expect(h.armed[0]?.instance).toBe("r2")
    })

    it.each(["completed", "failed", "cancelled", "terminated"] as const)(
      "raises nothing for a %s or unknown run",
      async (status) => {
        const h = harness()
        expect(await ensureTeamRecoveryInterrupt("missing", h.deps)).toBeUndefined()
        await seedParkedRun()
        await getDb().agentTeamRuns.update(RUN, { status })
        expect(await ensureTeamRecoveryInterrupt(RUN, h.deps)).toBeUndefined()
        expect(h.armed).toEqual([])
      }
    )
  })

  describe("armPendingTeamRecoveries", () => {
    it.each(["dispatch_initialization_failed", "evidence_incomplete"])(
      "re-arms actionable recovery after restart for %s",
      async (reason) => {
        await seedParkedRun(reason)
        const h = harness()
        expect(await armPendingTeamRecoveries(h.deps)).toEqual({ armed: 1, alreadyPending: 0 })
        expect(h.armed[0]?.subject).toMatchObject({ reason, choices: ALL_RECOVERY_CHOICES })
      }
    )
    it("re-arms every parked run without a pending recovery and counts the rest", async () => {
      await seedParkedRun()
      await createSquadRunRecords({
        runId: "run_team_rec02",
        teamId: "team-2",
        objective: "o",
        origin: "chat",
        startedAt: 1_000,
      })
      await getDb().agentTeamRuns.update("run_team_rec02", {
        status: "needs_input",
        recoveryReason: "legacy_run_not_resumable",
      })
      await getDb().executionRunInterrupts.add({
        id: "int-open-2",
        runId: "execution:team:run_team_rec02",
        type: "team_recovery",
        status: "pending",
        title: "recovery",
        reviewKind: "team_recovery",
        createdAt: 1,
        expiresAt: 10_000_000,
      } as ExecutionRunInterrupt)
      const h = harness()
      const outcome = await armPendingTeamRecoveries(h.deps)
      expect(outcome).toEqual({ armed: 1, alreadyPending: 1 })
      expect(h.armed.map((a) => a.instance)).toEqual(["r1"])
    })

    it("ignores runs parked for a deliberate operator reason", async () => {
      await seedParkedRun("operator_pause")
      const h = harness()
      expect(await armPendingTeamRecoveries(h.deps)).toEqual({ armed: 0, alreadyPending: 0 })
    })
  })

  describe("applyTeamRecoveryDecision", () => {
    it("composes real retry and resume state machines without stranding recovering work", async () => {
      await seedParkedRun()
      const coordinator = createDurableTeamCoordinator()
      await coordinator.registerChild({
        runId: RUN,
        childRunId: "real-child",
        teammateId: "m1",
        taskId: "task1",
        repositoryId: "repo",
        access: "read",
      })
      const reenter = jest.fn(async () => undefined)
      const result = await applyTeamRecoveryDecision(
        RUN,
        {
          subject: { choices: ALL_RECOVERY_CHOICES, uncertainChildIds: ["real-child"] },
        },
        "approve",
        { kind: "team_recovery", choice: "retry_same_host" },
        {
          retryChild: (id, host) => coordinator.retryChild(id, host),
          control: (id, action) => controlSquadRun(id, action, { isLive: () => false, reenter }),
        }
      )
      expect(result).toEqual({ applied: true, choice: "retry_same_host" })
      expect(reenter).toHaveBeenCalledTimes(1)
      expect((await getDb().agentTeamRuns.get(RUN))?.status).toBe("running")
    })

    it("restarts through the real launch transaction while the old run is parked", async () => {
      await seedParkedRun()
      const runLifecycle = jest.fn(async () => undefined)
      const stopReplacedRun = jest.fn(async () => undefined)
      const result = await applyTeamRecoveryDecision(
        RUN,
        {
          subject: { choices: ALL_RECOVERY_CHOICES, uncertainChildIds: [] },
        },
        "approve",
        { kind: "team_recovery", choice: "restart_run" },
        {
          startReplacement: (input) =>
            startSquadRun(
              {
                squadId: input.teamId,
                goal: input.objective,
                origin: "interactive",
                triggeredFrom: { source: "ui" },
                parentRunId: input.parentExecutionRunId,
                executionConstraints: input.executionConstraints,
              },
              {
                awaitRuntimeReady: async () => true,
                loadStore: async () => ({
                  getTeam: () => ({ id: "team-1", task: "changed after launch", config: {} }),
                  getTeammates: () => [],
                  getTeamTasks: () => [],
                  updateTeam: () => undefined,
                }),
                evaluateReadiness: async () => ({ ready: true, blockers: [], evaluatedAt: 1 }),
                runLifecycle,
                stopReplacedRun,
              }
            ),
          control: (id, action) => controlSquadRun(id, action),
        }
      )
      expect(result.applied).toBe(true)
      expect(stopReplacedRun).toHaveBeenCalledWith(RUN, "team-1")
      expect(runLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ requirePlanApprovalFloor: true, origin: "chat" })
      )
      expect((await getDb().agentTeamRuns.get(RUN))?.status).toBe("cancelled")
    })
    const subject = {
      reason: "uncertain_side_effect",
      choices: [...ALL_RECOVERY_CHOICES],
      uncertainChildIds: ["c1", "c2"],
      hostRef: "host-a",
    }

    it("terminate stops the run", async () => {
      await seedParkedRun()
      const h = harness()
      const result = await applyTeamRecoveryDecision(
        RUN,
        { subject },
        "approve",
        { kind: "team_recovery", choice: "terminate" },
        h.deps
      )
      expect(result).toEqual({ applied: true, choice: "terminate" })
      expect(h.controlled).toEqual([[RUN, "stop"]])
    })

    it("a deny is a terminate", async () => {
      await seedParkedRun()
      const h = harness()
      const result = await applyTeamRecoveryDecision(RUN, { subject }, "deny", undefined, h.deps)
      expect(result.choice).toBe("terminate")
      expect(h.controlled).toEqual([[RUN, "stop"]])
    })

    it("retry_same_host re-queues the uncertain children where they ran, then resumes", async () => {
      await seedParkedRun()
      const h = harness()
      const result = await applyTeamRecoveryDecision(
        RUN,
        { subject },
        "approve",
        { kind: "team_recovery", choice: "retry_same_host" },
        h.deps
      )
      expect(result).toEqual({ applied: true, choice: "retry_same_host" })
      expect(h.retried).toEqual([
        ["c1", undefined],
        ["c2", undefined],
      ])
      expect(h.controlled).toEqual([[RUN, "resume"]])
    })

    it("retry_host names the host, and a refused cross-host move leaves the run parked", async () => {
      await seedParkedRun()
      const h = harness({
        retryChild: async () => {
          throw new Error("Cross-host retry requires a safe checkpoint")
        },
      })
      const result = await applyTeamRecoveryDecision(
        RUN,
        { subject },
        "approve",
        { kind: "team_recovery", choice: "retry_host", hostRef: "host-b" },
        h.deps
      )
      expect(result).toEqual({ applied: false, choice: "retry_host", reason: "cross_host_unsafe" })
      expect(h.controlled).toEqual([])
    })

    it("restart_run launches a linked replacement first and stops the parked run after", async () => {
      await seedParkedRun()
      const order: string[] = []
      const h = harness({
        startReplacement: async (input) => {
          order.push(`start:${input.parentExecutionRunId}`)
          return { started: true, executionRunId: "execution:team:run_new" }
        },
        control: async (_runId, action) => {
          order.push(action)
          return { ok: true }
        },
      })
      const result = await applyTeamRecoveryDecision(
        RUN,
        { subject },
        "approve",
        { kind: "team_recovery", choice: "restart_run" },
        h.deps
      )
      expect(result).toEqual({
        applied: true,
        choice: "restart_run",
        replacementExecutionRunId: "execution:team:run_new",
      })
      expect(order).toEqual([`start:${EXECUTION}`, "stop"])
    })

    it("a refused replacement leaves the parked run untouched", async () => {
      await seedParkedRun()
      const h = harness({
        startReplacement: async () => ({ started: false, reason: "not_ready" }),
      })
      const result = await applyTeamRecoveryDecision(
        RUN,
        { subject },
        "approve",
        { kind: "team_recovery", choice: "restart_run" },
        h.deps
      )
      expect(result).toEqual({ applied: false, choice: "restart_run", reason: "restart_refused" })
      expect(h.controlled).toEqual([])
    })

    it("refuses a choice the interrupt did not offer", async () => {
      await seedParkedRun("legacy_run_not_resumable")
      const h = harness()
      const result = await applyTeamRecoveryDecision(
        RUN,
        { subject: { ...subject, choices: [...LEGACY_RECOVERY_CHOICES] } },
        "approve",
        { kind: "team_recovery", choice: "retry_same_host" },
        h.deps
      )
      expect(result).toEqual({
        applied: false,
        choice: "retry_same_host",
        reason: "choice_not_offered",
      })
      expect(h.retried).toEqual([])
    })
  })

  describe("applyTeamRecoveryFromControl", () => {
    it("reads the interrupt behind the command and applies its stored decision", async () => {
      await seedParkedRun()
      await seedInterrupt("int-ctl", "pending", {
        reason: "uncertain_side_effect",
        choices: [...ALL_RECOVERY_CHOICES],
        uncertainChildIds: ["c1"],
      })
      const h = harness()
      const result = await applyTeamRecoveryFromControl(
        {
          runId: EXECUTION,
          action: "approve",
          idempotencyKey: "k",
          expectedRevision: 1,
          actor: {},
          interruptId: "int-ctl",
          reviewDecision: { kind: "team_recovery", choice: "retry_same_host" },
        },
        h.deps
      )
      expect(result).toEqual({ applied: true, choice: "retry_same_host" })
      expect(h.retried).toEqual([["c1", undefined]])
    })

    it("refuses a command whose interrupt is not a recovery", async () => {
      await seedParkedRun()
      await getDb().executionRunInterrupts.add({
        id: "int-plan",
        runId: EXECUTION,
        type: "plan_approval",
        status: "pending",
        title: "plan",
        createdAt: 1,
        expiresAt: 10_000_000,
      } as ExecutionRunInterrupt)
      const result = await applyTeamRecoveryFromControl(
        {
          runId: EXECUTION,
          action: "approve",
          idempotencyKey: "k",
          expectedRevision: 1,
          actor: {},
          interruptId: "int-plan",
        },
        harness().deps
      )
      expect(result).toMatchObject({ applied: false, reason: "not_a_recovery" })
    })
  })
})
