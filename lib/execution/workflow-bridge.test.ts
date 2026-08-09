/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const stopAgentStateBridge = jest.fn()
jest.mock("./agent-state-bridge", () => ({
  startAgentStateExecutionBridge: jest.fn(() => stopAgentStateBridge),
}))

import { waitFor } from "@testing-library/dom"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetWorkflowExecutionBridgeForTesting,
  executionKindForWorkflowRun,
  startWorkflowExecutionBridge,
  syncWorkflowExecutionRun,
} from "./workflow-bridge"
import type { WorkflowRunRow } from "@/types/workflow/visual"

function workflowRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
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
    ...overrides,
  }
}

describe("workflow execution bridge", () => {
  beforeEach(async () => {
    __resetWorkflowExecutionBridgeForTesting()
    stopAgentStateBridge.mockClear()
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(() => {
    __resetWorkflowExecutionBridgeForTesting()
  })

  it("creates one shared run, durable binding, and idempotently maps source events", async () => {
    const row = workflowRun()
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
      activeSteps: [expect.objectContaining({ id: "step-1", title: "Step 1" })],
    })
    expect(await getDb().executionRunEvents.where("runId").equals(run!.id).count()).toBe(3)
    expect(await getDb().executionRunBindings.where("runId").equals(run!.id).first()).toMatchObject(
      {
        sourceMessageId: "message-1",
        deliveryMode: "native",
      }
    )
  })

  it.each([
    ["trigger.manual", "workflow"],
    ["trigger.team", "team"],
    ["trigger.goal.completed", "workflow"],
    ["trigger.cron", "scheduled"],
  ] as const)("maps %s to the shared %s run kind", (triggerKind, expectedKind) => {
    expect(executionKindForWorkflowRun({ triggerKind } as WorkflowRunRow)).toBe(expectedKind)
  })

  it("projects UI-triggered runs without fanout subscriptions", async () => {
    const row = workflowRun({
      id: "wf-run-ui",
      triggeredBySource: "ui",
      triggeredBy: undefined,
    })
    await getDb().workflowRuns.put(row)

    startWorkflowExecutionBridge()

    await waitFor(async () => {
      expect(await getDb().executionRuns.get("execution:workflow:wf-run-ui")).toBeDefined()
    })
  })
})
