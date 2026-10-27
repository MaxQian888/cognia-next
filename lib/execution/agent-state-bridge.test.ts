/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import * as schema from "@/lib/db/schema"
import { waitFor } from "@testing-library/react"

import type { ChatSession } from "@cognia/agent-config-types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import {
  EXECUTION_RUN_EVENT_RETENTION_MS,
  sweepExecutionRunEventRetention,
} from "@/lib/db/execution-runs"
import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"
import {
  agentStateExecutionRunId,
  startAgentStateExecutionBridge,
  __resetAgentStateExecutionBridgeForTesting,
  syncGoalExecutionRun,
  syncPlanExecutionRun,
} from "./agent-state-bridge"

function session(id = "session-1"): ChatSession {
  const conversationKey = `lark:lark-1:${id}`
  return {
    id,
    title: "IM session",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: {
      adapterId: "lark-1",
      platform: "lark",
      conversationKey,
      conversationRef: { platform: "lark", adapterId: "lark-1", chatId: id },
      deliveryTarget: {
        address: {
          adapterId: "lark-1",
          platform: "lark",
          conversationKey,
          scopeKind: "group",
          containerId: id,
        },
        conversationRef: { platform: "lark", adapterId: "lark-1", chatId: id },
        sourceMessageId: "source-message-1",
        refreshedAt: 1,
      },
    },
  }
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    sessionId: "session-1",
    rawObjective: "private objective",
    safeObjective: "redacted objective",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: {
      maxTurns: 20,
      maxTokens: 200_000,
      maxJudgeFailures: 3,
      timeoutMs: 1_800_000,
    },
    generationId: "generation-1",
    createdAt: 10,
    updatedAt: 20,
    subgoals: [
      { id: "goal-step-1", text: "private first step", done: true, order: 0 },
      { id: "goal-step-2", text: "private second step", done: false, order: 1 },
    ],
    ...overrides,
  }
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    title: "Release plan",
    source: "manual",
    executionMode: "auto",
    steps: [
      {
        id: "plan-step-1",
        title: "private first step",
        kind: "agent_turn",
        status: "completed",
        order: 0,
        dependencies: [],
      },
      {
        id: "plan-step-2",
        title: "private second step",
        kind: "agent_turn",
        status: "pending",
        order: 1,
        dependencies: ["plan-step-1"],
      },
    ],
    status: "awaiting_approval",
    totalSteps: 2,
    completedSteps: 1,
    config: {
      requireApproval: true,
      maxAutoRefinements: 2,
      maxStepRetries: 1,
      judgeDeviation: false,
      errorPolicy: "stop",
      maxConcurrency: 1,
    },
    refinementCount: 0,
    generationId: "generation-1",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

describe("agent state execution bridge", () => {
  afterEach(() => __resetAgentStateExecutionBridgeForTesting())

  beforeEach(async () => {
    __resetAgentStateExecutionBridgeForTesting()
    await getDb().delete()
    __resetDbForTesting()
  })

  it("keeps local Goal projection alive until the final owner releases it", async () => {
    const localSession = { ...session("portable-session"), platformBinding: undefined }
    await getDb().sessions.put(localSession)
    const first = startAgentStateExecutionBridge()
    const second = startAgentStateExecutionBridge()
    first()
    first()
    await getDb().chatGoals.put(goal({ id: "portable-goal", sessionId: localSession.id }))
    const runId = agentStateExecutionRunId("goal", "portable-goal")
    await waitFor(async () =>
      expect((await getDb().executionRuns.get(runId))?.latestSnapshot?.status).toBe("running")
    )
    await getDb().chatGoals.update("portable-goal", {
      status: "paused",
      generationId: "paused-generation",
      updatedAt: 30,
    })
    await waitFor(async () =>
      expect((await getDb().executionRuns.get(runId))?.latestSnapshot?.status).toBe("paused")
    )
    second()
    expect(await getDb().executionRunBindings.count()).toBe(0)
  })

  it("an old database owner's release cannot stop the new database subscription", () => {
    const stops: jest.Mock[] = []
    const liveQuery = jest.spyOn(Dexie, "liveQuery").mockImplementation(
      () =>
        ({
          subscribe: () => {
            const unsubscribe = jest.fn()
            stops.push(unsubscribe)
            return { unsubscribe, closed: false }
          },
        }) as never
    )
    try {
      const old = startAgentStateExecutionBridge()
      schema.activateAccountDatabase("acct_bridge_release_test", "another-target")
      const current = startAgentStateExecutionBridge()
      schema.clearAccountDatabaseSelection()
      expect(stops[0]).toHaveBeenCalledTimes(1)
      old()
      expect(stops[1]).not.toHaveBeenCalled()
      current()
      expect(stops[1]).toHaveBeenCalledTimes(1)
    } finally {
      liveQuery.mockRestore()
    }
  })

  it("keeps the same subscription across a schema connection replacement", async () => {
    let query!: () => Promise<unknown>
    const unsubscribe = jest.fn()
    const liveQuery = jest.spyOn(Dexie, "liveQuery").mockImplementation((callback) => {
      query = callback as () => Promise<unknown>
      return { subscribe: () => ({ unsubscribe, closed: false }) } as never
    })
    try {
      const first = startAgentStateExecutionBridge()
      __resetDbForTesting()
      const second = startAgentStateExecutionBridge()
      expect(liveQuery).toHaveBeenCalledTimes(1)
      expect(unsubscribe).not.toHaveBeenCalled()
      const localSession = { ...session(), platformBinding: undefined }
      await getDb().sessions.put(localSession)
      await getDb().chatGoals.put(goal())
      await expect(query()).resolves.toMatchObject({ goals: [{ goal: { id: "goal-1" } }] })
      first()
      expect(unsubscribe).not.toHaveBeenCalled()
      second()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      liveQuery.mockRestore()
    }
  })

  it("rejects a queued projection when its captured account scope is no longer active", async () => {
    await expect(syncGoalExecutionRun(goal(), session(), () => false)).rejects.toThrow(
      "database changed"
    )
    expect(await getDb().executionRuns.count()).toBe(0)
  })

  it("does not create a run if the account changes while reading the existing projection", async () => {
    let release!: () => void
    const pending = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined)
    })
    const read = jest.spyOn(getDb().executionRuns, "get").mockReturnValueOnce(pending as never)
    let current = true
    const projection = syncGoalExecutionRun(goal(), session(), () => current)
    current = false
    release()
    try {
      await expect(projection).rejects.toThrow("database changed")
      expect(await getDb().executionRuns.count()).toBe(0)
    } finally {
      read.mockRestore()
    }
  })

  it("retries a projection transaction reopening within the captured database", async () => {
    const row = { ...session(), platformBinding: undefined }
    await syncGoalExecutionRun(goal(), row)
    const transaction = jest
      .spyOn(getDb(), "transaction")
      .mockRejectedValueOnce(new Dexie.DatabaseClosedError("schema closed"))
    try {
      await expect(syncGoalExecutionRun(goal({ updatedAt: 30 }), row)).resolves.toBeUndefined()
      expect(transaction).toHaveBeenCalledTimes(2)
      expect(
        (await getDb().executionRuns.get(agentStateExecutionRunId("goal", "goal-1")))
          ?.currentRevision
      ).toBe(7)
    } finally {
      transaction.mockRestore()
    }
  })

  it("does not retry a projection transaction into a replacement account or target", async () => {
    const row = { ...session(), platformBinding: undefined }
    await syncGoalExecutionRun(goal(), row)
    const initial = getDb()
    let replacement: schema.CogniaDB | undefined
    const transaction = jest.spyOn(initial, "transaction").mockImplementationOnce(() => {
      schema.activateAccountDatabase("acct_projection_retry_test", "other-target")
      replacement = getDb()
      return Promise.reject(new Dexie.DatabaseClosedError("schema closed")) as never
    })
    try {
      await expect(syncGoalExecutionRun(goal({ updatedAt: 30 }), row)).rejects.toThrow(
        "database changed"
      )
      expect(transaction).toHaveBeenCalledTimes(1)
      expect(await replacement!.executionRuns.count()).toBe(0)
      expect(await replacement!.executionRunEvents.count()).toBe(0)
      expect(await replacement!.executionRunBindings.count()).toBe(0)
      expect(await replacement!.notificationProjectionWork.count()).toBe(0)
    } finally {
      transaction.mockRestore()
      await replacement?.delete()
      schema.clearAccountDatabaseSelection()
    }
  })

  it("rolls back a projection if its captured scope changes during journal writes", async () => {
    const row = { ...session(), platformBinding: undefined }
    await syncGoalExecutionRun(goal(), row)
    const db = getDb()
    const runId = agentStateExecutionRunId("goal", "goal-1")
    const before = await db.executionRuns.get(runId)
    const events = await db.executionRunEvents.where("runId").equals(runId).toArray()
    const projectionWork = await db.notificationProjectionWork.toArray()
    let current = true
    const add = db.executionRunEvents.add.bind(db.executionRunEvents)
    const write = jest.spyOn(db.executionRunEvents, "add").mockImplementationOnce((event) =>
      add(event).then((id) => {
        current = false
        return id
      })
    )
    try {
      await expect(
        syncGoalExecutionRun(goal({ updatedAt: 30 }), row, () => current)
      ).rejects.toThrow("database changed")
      expect(write).toHaveBeenCalled()
      expect(await db.executionRuns.get(runId)).toEqual(before)
      expect(await db.executionRunEvents.where("runId").equals(runId).toArray()).toEqual(events)
      expect(await db.notificationProjectionWork.toArray()).toEqual(projectionWork)
    } finally {
      write.mockRestore()
    }
  })

  it("projects a live Goal into the shared durable run and binding without objective text", async () => {
    const row = session()
    await syncGoalExecutionRun(goal(), row)
    await syncGoalExecutionRun(goal(), row)

    const runId = agentStateExecutionRunId("goal", "goal-1")
    const run = await getDb().executionRuns.get(runId)
    expect(run?.latestSnapshot).toMatchObject({
      kind: "goal",
      title: "redacted objective",
      status: "running",
      progress: { completed: 1, total: 2, trustworthy: true },
    })
    expect(JSON.stringify(run?.latestSnapshot)).not.toContain("private objective")
    expect(JSON.stringify(run?.latestSnapshot)).not.toContain("private first step")
    expect(await getDb().executionRunEvents.where("runId").equals(runId).count()).toBe(4)
    expect(await getDb().executionRunBindings.where("runId").equals(runId).first()).toMatchObject({
      sourceMessageId: "source-message-1",
      deliveryMode: "native",
    })
  })

  it("projects a structured Plan and keeps waiting state idempotent", async () => {
    const row = session()
    await syncPlanExecutionRun(plan(), row)
    await syncPlanExecutionRun(plan(), row)

    const runId = agentStateExecutionRunId("plan", "plan-1")
    const run = await getDb().executionRuns.get(runId)
    expect(run?.latestSnapshot).toMatchObject({
      kind: "plan",
      status: "waiting",
      progress: { completed: 1, total: 2, trustworthy: true },
    })
    expect(run?.latestSnapshot?.pendingInterrupt).toBeUndefined()
    expect(run?.latestSnapshot?.allowedActions).toEqual(["stop", "open_details"])
    expect(JSON.stringify(run?.latestSnapshot)).not.toContain("private first step")
    expect(await getDb().executionRunEvents.where("runId").equals(runId).count()).toBe(4)
  })

  it.each(["completed", "failed", "cancelled"] as const)(
    "preserves a %s Plan journal when later source snapshots are replayed",
    async (status) => {
      const row = session()
      await syncPlanExecutionRun(plan({ status }), row)
      const runId = agentStateExecutionRunId("plan", "plan-1")
      const before = await getDb().executionRuns.get(runId)
      const events = await getDb().executionRunEvents.where("runId").equals(runId).toArray()
      expect(before?.status).toBe(status)

      await expect(
        syncPlanExecutionRun(plan({ status, updatedAt: 30 }), row)
      ).resolves.toBeUndefined()
      await expect(
        syncPlanExecutionRun(
          plan({ status: "executing", updatedAt: 40, generationId: "later-generation" }),
          row
        )
      ).resolves.toBeUndefined()

      expect(await getDb().executionRuns.get(runId)).toEqual(before)
      expect(await getDb().executionRunEvents.where("runId").equals(runId).toArray()).toEqual(
        events
      )
    }
  )

  it.each([
    ["completed", "completed"],
    ["budget_limited", "failed"],
    ["stopped", "cancelled"],
  ] as const)(
    "preserves a %s Goal journal when later source snapshots are replayed",
    async (status, executionStatus) => {
      const row = session()
      await syncGoalExecutionRun(goal({ status }), row)
      const runId = agentStateExecutionRunId("goal", "goal-1")
      const before = await getDb().executionRuns.get(runId)
      const events = await getDb().executionRunEvents.where("runId").equals(runId).toArray()
      expect(before?.status).toBe(executionStatus)

      await expect(
        syncGoalExecutionRun(goal({ status, updatedAt: 30 }), row)
      ).resolves.toBeUndefined()
      await expect(
        syncGoalExecutionRun(
          goal({ status: "active", updatedAt: 40, generationId: "later-generation" }),
          row
        )
      ).resolves.toBeUndefined()

      expect(await getDb().executionRuns.get(runId)).toEqual(before)
      expect(await getDb().executionRunEvents.where("runId").equals(runId).toArray()).toEqual(
        events
      )
    }
  )

  it.each(["plan", "goal"] as const)(
    "does not recreate pruned events when replaying a retained terminal %s",
    async (kind) => {
      const row = { ...session(), platformBinding: undefined }
      const sync =
        kind === "plan"
          ? () => syncPlanExecutionRun(plan({ status: "cancelled" }), row)
          : () => syncGoalExecutionRun(goal({ status: "stopped" }), row)
      await sync()
      const runId = agentStateExecutionRunId(kind, `${kind}-1`)
      const before = await getDb().executionRuns.get(runId)
      expect(before?.status).toBe("cancelled")
      expect(await sweepExecutionRunEventRetention(21 + EXECUTION_RUN_EVENT_RETENTION_MS)).toBe(4)

      await expect(sync()).resolves.toBeUndefined()

      expect(await getDb().executionRuns.get(runId)).toEqual(before)
      expect(await getDb().executionRunEvents.where("runId").equals(runId).count()).toBe(0)
    }
  )

  it.each(["plan", "goal"] as const)(
    "serializes overlapping %s projections through completion",
    async (kind) => {
      const row = session()
      const sync =
        kind === "plan"
          ? (completed: boolean, updatedAt: number) =>
              syncPlanExecutionRun(
                plan({ status: completed ? "completed" : "executing", updatedAt }),
                row
              )
          : (completed: boolean, updatedAt: number) =>
              syncGoalExecutionRun(
                goal({ status: completed ? "completed" : "active", updatedAt }),
                row
              )
      await sync(false, 20)

      const results = await Promise.allSettled([sync(true, 30), sync(false, 40), sync(true, 50)])

      expect(results).toEqual(
        Array.from({ length: 3 }, () => ({ status: "fulfilled", value: undefined }))
      )
      const runId = agentStateExecutionRunId(kind, `${kind}-1`)
      expect((await getDb().executionRuns.get(runId))?.status).toBe("completed")
      const events = await getDb()
        .executionRunEvents.where("[runId+seq]")
        .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
        .toArray()
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1)
      expect(events.at(-1)?.type).toBe("run.completed")
    }
  )

  it("projects a rejected Plan as a declined (cancelled) run", async () => {
    const row = session()
    await syncPlanExecutionRun(plan({ id: "plan-rejected", status: "rejected" }), row)
    const run = await getDb().executionRuns.get(agentStateExecutionRunId("plan", "plan-rejected"))
    expect(run?.latestSnapshot).toMatchObject({ kind: "plan", status: "cancelled" })
  })

  it("does not create a presenter binding when live activity is disabled", async () => {
    const row = session("session-disabled")
    await upsertByConversationKey({
      conversationKey: row.platformBinding!.conversationKey,
      sessionId: row.id,
      liveActivity: false,
    })

    await syncGoalExecutionRun(goal({ id: "goal-disabled", sessionId: row.id }), row)

    const runId = agentStateExecutionRunId("goal", "goal-disabled")
    expect(await getDb().executionRuns.get(runId)).toBeDefined()
    expect(await getDb().executionRunBindings.where("runId").equals(runId).count()).toBe(0)
  })

  it("journals local-only goal and plan runs without creating presenter bindings", async () => {
    const localSession = { ...session("session-local"), platformBinding: undefined }
    await syncGoalExecutionRun(goal({ id: "goal-local", sessionId: localSession.id }), localSession)
    await syncPlanExecutionRun(plan({ id: "plan-local", sessionId: localSession.id }), localSession)

    expect(
      await getDb().executionRuns.get(agentStateExecutionRunId("goal", "goal-local"))
    ).toBeDefined()
    expect(
      await getDb().executionRuns.get(agentStateExecutionRunId("plan", "plan-local"))
    ).toBeDefined()
    expect(await getDb().executionRunBindings.count()).toBe(0)
  })
})
