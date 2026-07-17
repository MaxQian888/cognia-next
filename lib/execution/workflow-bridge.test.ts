/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { syncWorkflowExecutionRun } from "./workflow-bridge"
import type { WorkflowRunRow } from "@/types/workflow/visual"

describe("workflow execution bridge", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("creates one shared run, durable binding, and idempotently maps source events", async () => {
    const row: WorkflowRunRow = {
      id: "wf-run-1",
      workflowId: "wf-1",
      status: "running",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 1,
      triggeredBySource: "im",
      triggeredBy: {
        source: "im",
        adapterId: "lark-1",
        conversationKey: "lark:lark-1:chat-1",
        sessionId: "session-1",
        sourceMessageId: "message-1",
      },
      workflowSnapshot: {
        id: "wf-1",
        name: "Release",
        description: "",
        schemaVersion: 1,
        createdAt: 1,
        updatedAt: 1,
        nodes: [
          {
            id: "step-1",
            type: "ai.prompt",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "Draft", params: {} },
          },
        ],
        edges: [],
        settings: {
          errorPolicy: "stop",
          timeoutMs: 0,
          concurrency: 1,
          retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
        },
      },
    }
    const event = {
      id: "source-event-1",
      runId: row.id,
      ts: 2,
      type: "step_started" as const,
      stepId: "step-1",
    }

    await syncWorkflowExecutionRun(row, [event], [])
    await syncWorkflowExecutionRun(row, [event], [])

    const run = await getDb().executionRuns.get("execution:workflow:wf-run-1")
    expect(run?.latestSnapshot).toMatchObject({
      kind: "workflow",
      progress: { total: 1, trustworthy: true },
      activeSteps: [expect.objectContaining({ id: "step-1", title: "Draft" })],
    })
    expect(await getDb().executionRunEvents.where("runId").equals(run!.id).count()).toBe(3)
    expect(await getDb().executionRunBindings.where("runId").equals(run!.id).first()).toMatchObject(
      {
        sourceMessageId: "message-1",
        deliveryMode: "native",
      }
    )
  })
})
