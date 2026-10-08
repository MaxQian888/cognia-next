/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import * as schema from "./schema"
import type { ExecutionRun, RunEvent } from "@/types/execution/run"
import { reduceRunEvents } from "@/lib/execution/run-reducer"

import { __resetDbForTesting, getDb } from "./schema"
import {
  createExecutionRun,
  createExecutionRunBinding,
  getExecutionRun,
  getExecutionRunBinding,
  getExecutionRunSnapshot,
  listExecutionRunEvents,
  listExecutionRuns,
  listVisibleExecutionRunEvents,
  listExecutionRunBindings,
  putExecutionRunBinding,
  runEventJournal,
  sweepExecutionRunEventRetention,
  semanticRunEvent,
  updateExecutionRunBinding,
} from "./execution-runs"

describe("execution run journal", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it.each(["create", "binding", "append", "appendBatch"] as const)(
    "does not retry %s into another account or target database",
    async (operation) => {
      const initial = getDb()
      let replacement: schema.CogniaDB | undefined
      const abortFirstAttempt = () => {
        schema.activateAccountDatabase("acct_journal_retry_test", "other-target")
        replacement = getDb()
        return Promise.reject(new Dexie.DatabaseClosedError("schema closed"))
      }
      const run: ExecutionRun = {
        id: "scope-run",
        kind: "goal",
        sourceId: "goal-1",
        title: "Private title",
        status: "queued",
        currentRevision: 0,
        startedAt: 1,
        updatedAt: 1,
      }
      const event = {
        type: "run.started" as const,
        ts: 1,
        visibility: "summary" as const,
        payload: {},
      }
      let firstAttempt: jest.SpyInstance
      let result: Promise<unknown>
      if (operation === "create") {
        firstAttempt = jest
          .spyOn(initial.executionRuns, "add")
          .mockImplementationOnce(abortFirstAttempt as never)
        result = createExecutionRun(run)
      } else if (operation === "binding") {
        firstAttempt = jest
          .spyOn(initial.executionRunBindings, "put")
          .mockImplementationOnce(abortFirstAttempt as never)
        result = putExecutionRunBinding({ id: "binding", runId: run.id } as Parameters<
          typeof putExecutionRunBinding
        >[0])
      } else {
        firstAttempt = jest
          .spyOn(initial, "transaction")
          .mockImplementationOnce(abortFirstAttempt as never)
        result =
          operation === "append"
            ? runEventJournal.append(run.id, event)
            : runEventJournal.appendBatch(run.id, [event])
      }
      try {
        await expect(result).rejects.toThrow("Execution journal database changed")
        expect(firstAttempt).toHaveBeenCalledTimes(1)
        expect(await replacement!.executionRuns.count()).toBe(0)
        expect(await replacement!.executionRunBindings.count()).toBe(0)
        expect(await replacement!.executionRunEvents.count()).toBe(0)
      } finally {
        firstAttempt.mockRestore()
        await replacement?.delete()
        schema.clearAccountDatabaseSelection()
      }
    }
  )

  it("retries a schema reopen in the same database namespace", async () => {
    const initial = getDb()
    let replacement: schema.CogniaDB | undefined
    const firstAttempt = jest.spyOn(initial.executionRuns, "add").mockImplementationOnce(() => {
      __resetDbForTesting()
      replacement = getDb()
      return Promise.reject(new Dexie.DatabaseClosedError("schema closed")) as never
    })
    const run: ExecutionRun = {
      id: "reopened-run",
      kind: "goal",
      sourceId: "goal-1",
      title: "Goal",
      status: "queued",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    }
    try {
      await expect(createExecutionRun(run)).resolves.toEqual(run)
      expect(await replacement!.executionRuns.get(run.id)).toEqual(run)
    } finally {
      firstAttempt.mockRestore()
      replacement?.close()
    }
  })

  it("never overwrites an existing immutable run during duplicate creation", async () => {
    const completed: ExecutionRun = {
      id: "duplicate-run",
      kind: "agent-turn",
      sourceId: "message-1",
      title: "Completed",
      status: "completed",
      currentRevision: 1,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
    }
    await createExecutionRun(completed)

    await expect(
      createExecutionRun({
        ...completed,
        title: "Reopened",
        status: "queued",
        currentRevision: 0,
        endedAt: undefined,
      })
    ).rejects.toBeDefined()
    expect(await getExecutionRun(completed.id)).toEqual(completed)
  })

  it("atomically assigns monotonic sequences and persists a replayable snapshot", async () => {
    await createExecutionRun({
      id: "run-journal",
      kind: "agent-turn",
      sourceId: "session-1:turn-1",
      sessionId: "session-1",
      title: "Research APIs",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
      currentRevision: 0,
    })

    const first = await runEventJournal.append("run-journal", {
      type: "step.added",
      ts: 1_001,
      visibility: "summary",
      payload: { stepId: "search", title: "Search official docs" },
    })
    const second = await runEventJournal.append("run-journal", {
      type: "step.started",
      ts: 1_002,
      visibility: "summary",
      payload: { stepId: "search", title: "Search official docs" },
    })

    expect([first.seq, second.seq]).toEqual([1, 2])
    await expect(listExecutionRunEvents("run-journal")).resolves.toEqual([
      expect.objectContaining({ seq: 1, type: "step.added" }),
      expect.objectContaining({ seq: 2, type: "step.started" }),
    ])
    await expect(getExecutionRunSnapshot("run-journal")).resolves.toEqual(
      expect.objectContaining({
        revision: 2,
        activeSteps: [expect.objectContaining({ id: "search" })],
      })
    )
  })

  it("touches the notification projection work row in the same commit", async () => {
    // Commit-first: every journal append must raise the durable
    // `notificationProjectionWork` dirty-marker atomically — the projector
    // never learns of an event that isn't committed, and never misses one
    // that is.
    await createExecutionRun({
      id: "run-notify",
      kind: "agent-turn",
      sourceId: "session-1:turn-1",
      title: "Notify",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
      currentRevision: 0,
    })

    await runEventJournal.append("run-notify", {
      type: "step.added",
      ts: 1_001,
      visibility: "summary",
      payload: { stepId: "s1" },
    })
    let work = await getDb()
      .notificationProjectionWork.where("subjectKey")
      .equals("run:run-notify")
      .first()
    expect(work?.desiredRunSeq).toBe(1)
    expect(work?.state).toBe("pending")

    // A second append raises the desired seq — a single touch per commit,
    // not one row per event.
    await runEventJournal.append("run-notify", {
      type: "step.started",
      ts: 1_002,
      visibility: "summary",
      payload: { stepId: "s1" },
    })
    work = await getDb()
      .notificationProjectionWork.where("subjectKey")
      .equals("run:run-notify")
      .first()
    expect(work?.desiredRunSeq).toBe(2)
    expect(await getDb().notificationProjectionWork.count()).toBe(1)
  })

  it("deduplicates a source event without consuming another sequence", async () => {
    await createExecutionRun({
      id: "run-dedupe",
      kind: "workflow",
      sourceId: "wf-run-1",
      title: "Workflow",
      status: "running",
      startedAt: 1_000,
      updatedAt: 1_000,
      currentRevision: 0,
    })
    const input = {
      type: "run.started" as const,
      ts: 1_001,
      visibility: "summary" as const,
      payload: {},
      sourceEventId: "wf-event-1",
    }

    const first = await runEventJournal.append("run-dedupe", input)
    const duplicate = await runEventJournal.append("run-dedupe", input)

    expect(duplicate.id).toBe(first.id)
    expect(await listExecutionRunEvents("run-dedupe")).toHaveLength(1)
    expect((await getDb().executionRuns.get("run-dedupe"))?.currentRevision).toBe(1)
  })

  it("rejects events for a run that does not exist", async () => {
    await expect(
      runEventJournal.append("missing-run", {
        type: "run.started",
        ts: 1,
        visibility: "summary",
        payload: {},
      })
    ).rejects.toThrow("Execution run not found: missing-run")
  })

  it("keeps terminal runs immutable while preserving duplicate delivery idempotency", async () => {
    await createExecutionRun({
      id: "run-terminal",
      kind: "agent-turn",
      sourceId: "turn-terminal",
      title: "Terminal",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const completed = semanticRunEvent("run.completed", {}, { sourceEventId: "completed" })
    const first = await runEventJournal.append("run-terminal", completed)
    await expect(runEventJournal.append("run-terminal", completed)).resolves.toEqual(first)
    await expect(
      runEventJournal.append("run-terminal", semanticRunEvent("step.added", { stepId: "late" }))
    ).rejects.toThrow("Execution run is terminal: run-terminal")
  })

  it("queries the canonical run table and hides private events by default", async () => {
    await createExecutionRun({
      id: "run-query",
      kind: "goal",
      sourceId: "goal-query",
      projectId: "project-a",
      title: "Query",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await runEventJournal.appendBatch("run-query", [
      semanticRunEvent("run.started", {}, { visibility: "summary", sourceEventId: "public" }),
      semanticRunEvent(
        "step.progress",
        { detail: "private" },
        { visibility: "private", sourceEventId: "private" }
      ),
    ])

    await expect(
      listExecutionRuns({ kinds: ["goal"], projectId: "project-a", limit: 10 })
    ).resolves.toEqual([expect.objectContaining({ id: "run-query" })])
    await expect(listVisibleExecutionRunEvents("run-query")).resolves.toHaveLength(1)
    await expect(listVisibleExecutionRunEvents("run-query", true)).resolves.toHaveLength(2)
  })

  it("appends a batch sequentially and keeps explicit ids idempotent", async () => {
    await createExecutionRun({
      id: "run-batch",
      kind: "workflow",
      sourceId: "workflow-batch",
      projectId: "project-a",
      title: "Batch",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const inputs = [
      semanticRunEvent("run.started", {}, { ts: 2 }),
      {
        id: "explicit-step",
        type: "step.added" as const,
        ts: 3,
        visibility: "detail" as const,
        payload: { stepId: "step-a", title: "Step A" },
      },
    ]

    const first = await runEventJournal.appendBatch("run-batch", inputs)
    const duplicate = await runEventJournal.appendBatch("run-batch", [inputs[1]])

    expect(first.map((event) => event.seq)).toEqual([1, 2])
    expect(first.every((event) => event.projectId === "project-a")).toBe(true)
    expect(duplicate[0]).toEqual(first[1])
    expect(await runEventJournal.replay("run-batch")).toHaveLength(2)
  })

  it("loads batch history once while preserving mixed duplicate deliveries", async () => {
    const db = getDb()
    await createExecutionRun({
      id: "batch-history",
      kind: "workflow",
      sourceId: "workflow-history",
      title: "History",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const oldInput = semanticRunEvent("run.started", {}, { ts: 2, sourceEventId: "old" })
    const oldEvent = await runEventJournal.append("batch-history", oldInput)
    const explicit = {
      ...semanticRunEvent("step.added", { stepId: "a" }, { ts: 3 }),
      id: "explicit-new",
    }
    const sourced = semanticRunEvent(
      "step.started",
      { stepId: "a" },
      { ts: 4, sourceEventId: "new" }
    )
    const historyReads = jest.spyOn(db.executionRunEvents, "where")
    let appended: RunEvent[]
    try {
      appended = await runEventJournal.appendBatch("batch-history", [
        oldInput,
        explicit,
        explicit,
        sourced,
        sourced,
      ])
      expect(historyReads).toHaveBeenCalledTimes(1)
    } finally {
      historyReads.mockRestore()
    }
    expect(appended!.map((event) => event.seq)).toEqual([1, 2, 2, 3, 3])
    expect(appended![0]).toEqual(oldEvent)
    expect(appended![1]).toEqual(appended![2])
    expect(appended![3]).toEqual(appended![4])
    const run = (await getExecutionRun("batch-history"))!
    const replay = await runEventJournal.replay(run.id)
    expect(run.latestSnapshot).toEqual(reduceRunEvents({ ...run, currentRevision: 0 }, replay))
    expect(
      (await db.notificationProjectionWork.where("subjectKey").equals(`run:${run.id}`).first())
        ?.desiredRunSeq
    ).toBe(3)
  })

  it("rolls back a terminal mid-batch and discards its cached history", async () => {
    const db = getDb()
    await createExecutionRun({
      id: "batch-rollback",
      kind: "workflow",
      sourceId: "workflow-rollback",
      title: "Rollback",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await runEventJournal.append("batch-rollback", semanticRunEvent("run.started", {}, { ts: 2 }))
    const beforeRun = await getExecutionRun("batch-rollback")
    const beforeEvents = await runEventJournal.replay("batch-rollback")
    const beforeWork = await db.notificationProjectionWork.toArray()
    await expect(
      runEventJournal.appendBatch("batch-rollback", [
        semanticRunEvent("step.added", { stepId: "a" }, { ts: 3 }),
        semanticRunEvent("run.completed", { summary: "Done" }, { ts: 4 }),
        semanticRunEvent("step.started", { stepId: "a" }, { ts: 5 }),
      ])
    ).rejects.toThrow("Execution run is terminal")
    expect(await getExecutionRun("batch-rollback")).toEqual(beforeRun)
    expect(await runEventJournal.replay("batch-rollback")).toEqual(beforeEvents)
    expect(await db.notificationProjectionWork.toArray()).toEqual(beforeWork)
    const completed = semanticRunEvent("run.completed", {}, { ts: 7, sourceEventId: "completed" })
    const retry = await runEventJournal.appendBatch("batch-rollback", [
      semanticRunEvent("step.added", { stepId: "b" }, { ts: 6 }),
      completed,
      completed,
    ])
    expect(retry.map((event) => event.seq)).toEqual([2, 3, 3])
    expect((await getExecutionRun("batch-rollback"))?.latestSnapshot?.revision).toBe(3)
  })

  it("keeps canonical primary-key order when legacy history has a sequence gap and conflict", async () => {
    const db = getDb()
    await createExecutionRun({
      id: "batch-legacy",
      kind: "workflow",
      sourceId: "workflow-legacy",
      title: "Legacy",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await db.executionRunEvents.bulkPut([
      {
        id: "y-legacy",
        runId: "batch-legacy",
        seq: 3,
        ts: 9,
        type: "run.waiting",
        visibility: "summary",
        payload: {},
      },
      {
        id: "z-legacy",
        runId: "batch-legacy",
        seq: 3,
        ts: 10,
        type: "run.paused",
        visibility: "summary",
        payload: {},
      },
    ])
    const events = await runEventJournal.appendBatch("batch-legacy", [
      { ...semanticRunEvent("run.started", {}, { ts: 2 }), id: "new-first" },
      { ...semanticRunEvent("step.added", { stepId: "a" }, { ts: 3 }), id: "new-second" },
      { ...semanticRunEvent("step.started", { stepId: "a" }, { ts: 4 }), id: "a-new-third" },
    ])
    const run = (await getExecutionRun("batch-legacy"))!
    const replay = await runEventJournal.replay(run.id)
    expect(events.map((event) => event.seq)).toEqual([1, 2, 4])
    expect(run.latestSnapshot).toEqual(reduceRunEvents({ ...run, currentRevision: 0 }, replay))
    expect(run.status).toBe("waiting")
  })

  it("rebuilds batch history after a retried transaction abort", async () => {
    const db = getDb()
    await createExecutionRun({
      id: "batch-reopen",
      kind: "workflow",
      sourceId: "workflow-reopen",
      title: "Reopen",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const originalUpdate = db.executionRuns.update.bind(db.executionRuns)
    let attempts = 0
    const update = jest.spyOn(db.executionRuns, "update").mockImplementation((...args) => {
      if (++attempts === 2)
        return Promise.reject(new Dexie.DatabaseClosedError("schema closed")) as never
      return originalUpdate(...args)
    })
    try {
      const inputs = [
        { ...semanticRunEvent("run.started", {}, { ts: 2 }), id: "retry-start" },
        { ...semanticRunEvent("step.added", { stepId: "a" }, { ts: 3 }), id: "retry-step" },
      ]
      const appended = await runEventJournal.appendBatch("batch-reopen", inputs)
      expect(appended.map((event) => event.seq)).toEqual([1, 2])
      const replay = await runEventJournal.replay("batch-reopen")
      expect(replay.map((event) => event.id)).toEqual(["retry-start", "retry-step"])
      const run = (await getExecutionRun("batch-reopen"))!
      expect(run.latestSnapshot).toEqual(reduceRunEvents({ ...run, currentRevision: 0 }, replay))
      expect(attempts).toBe(4)
    } finally {
      update.mockRestore()
    }
  })

  it("redacts sensitive strings before they enter the durable journal", async () => {
    await createExecutionRun({
      id: "run-redaction",
      kind: "agent-turn",
      sourceId: "turn-redaction",
      title: "Agent",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })

    await runEventJournal.append("run-redaction", {
      type: "tool.completed",
      ts: 2,
      visibility: "summary",
      payload: { summary: "Contact alice@example.com", nested: { value: "13800138000" } },
    })

    const persisted = JSON.stringify(await listExecutionRunEvents("run-redaction"))
    expect(persisted).not.toContain("alice@example.com")
    expect(persisted).not.toContain("13800138000")
  })

  it("persists presentation cursor state independently from the run journal", async () => {
    await createExecutionRunBinding({
      id: "binding-1",
      runId: "run-1",
      adapterId: "lark-1",
      conversationKey: "lark:lark-1:chat-1",
      status: "active",
      deliveryMode: "native",
      lastProjectedRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await updateExecutionRunBinding("binding-1", {
      platformMessageId: "message-1",
      presentationState: { cardId: "card-1", sequence: 2 },
      lastProjectedRevision: 3,
      updatedAt: 4,
    })

    expect(await getExecutionRunBinding("binding-1")).toMatchObject({
      platformMessageId: "message-1",
      presentationState: { cardId: "card-1", sequence: 2 },
      lastProjectedRevision: 3,
    })
  })

  it("stamps updatedAt on a binding patch that omits it, so the sync cursor moves", async () => {
    await createExecutionRunBinding({
      id: "binding-stamp",
      runId: "run-1",
      adapterId: "lark-1",
      conversationKey: "lark:lark-1:chat-1",
      status: "active",
      deliveryMode: "native",
      lastProjectedRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(4_242)
    try {
      await updateExecutionRunBinding("binding-stamp", { status: "finished" })
    } finally {
      nowSpy.mockRestore()
    }
    expect(await getExecutionRunBinding("binding-stamp")).toMatchObject({
      status: "finished",
      updatedAt: 4_242,
    })
    // An explicit stamp is kept as given.
    await updateExecutionRunBinding("binding-stamp", { status: "disabled", updatedAt: 9 })
    expect((await getExecutionRunBinding("binding-stamp"))?.updatedAt).toBe(9)
  })

  it("puts and lists bindings without duplicating their durable identity", async () => {
    const binding = {
      id: "binding-put",
      runId: "run-put",
      adapterId: "lark-1",
      conversationKey: "lark:lark-1:chat-1",
      status: "active" as const,
      deliveryMode: "native" as const,
      lastProjectedRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    }

    await putExecutionRunBinding(binding)
    await putExecutionRunBinding({ ...binding, lastProjectedRevision: 2, updatedAt: 2 })

    expect(await listExecutionRunBindings(binding.runId)).toEqual([
      expect.objectContaining({ id: binding.id, lastProjectedRevision: 2 }),
    ])
  })

  it("returns the persisted run and applies semantic event defaults and overrides", async () => {
    const run = {
      id: "run-get",
      kind: "agent-turn" as const,
      sourceId: "turn-get",
      title: "Get",
      status: "running" as const,
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    }
    await createExecutionRun(run)

    expect(await getExecutionRun(run.id)).toEqual(run)
    expect(semanticRunEvent("run.started", {}).visibility).toBe("summary")
    expect(
      semanticRunEvent(
        "run.started",
        {},
        {
          ts: 42,
          visibility: "private",
          sourceEventId: "source-42",
        }
      )
    ).toMatchObject({ ts: 42, visibility: "private", sourceEventId: "source-42" })
  })

  it("removes semantic events 30 days after terminal state while preserving the run snapshot", async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1_000
    await createExecutionRun({
      id: "old-run",
      kind: "agent-turn",
      sourceId: "old-turn",
      title: "Old run",
      status: "running",
      currentRevision: 0,
      startedAt: old - 1,
      updatedAt: old - 1,
    })
    await runEventJournal.append("old-run", {
      type: "run.completed",
      ts: old,
      visibility: "summary",
      payload: { summary: "done" },
    })

    expect(await sweepExecutionRunEventRetention()).toBe(1)
    expect(await listExecutionRunEvents("old-run")).toHaveLength(0)
    expect(await getExecutionRunSnapshot("old-run")).toMatchObject({ status: "completed" })
  })
})
