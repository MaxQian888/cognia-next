/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "./schema"
import {
  createExecutionRun,
  createExecutionRunBinding,
  getExecutionRun,
  getExecutionRunBinding,
  getExecutionRunSnapshot,
  listExecutionRunEvents,
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
          visibility: "internal",
          sourceEventId: "source-42",
        }
      )
    ).toMatchObject({ ts: 42, visibility: "internal", sourceEventId: "source-42" })
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
