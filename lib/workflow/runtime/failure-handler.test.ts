/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => ({
    dispatchWorkflowStart: jest.fn(),
    dispatchWorkflowStepComplete: jest.fn(),
    dispatchWorkflowComplete: jest.fn(),
    dispatchWorkflowError: jest.fn(),
    dispatchWorkflowNodeStart: jest.fn(),
    dispatchWorkflowNodeComplete: jest.fn(),
    dispatchWorkflowNodeError: jest.fn(),
    dispatchWorkflowTriggerFired: jest.fn(),
  })),
}))
jest.mock("@/lib/terminal/headless-session-registry", () => ({
  closeRunSessions: jest.fn(async () => undefined),
}))

import { runWorkflow } from "./orchestrator"
import { findCatchNodes } from "./failure-handler"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listRunEvents } from "./event-log"
import type { TriggerEvent, VisualWorkflow } from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
})

const trigger: TriggerEvent = {
  workflowId: "wf_f",
  kind: "trigger.manual",
  payload: {},
  originAt: 1_700_000_000,
}

/** A node that always fails terminally: flow.subworkflow with no workflowId. */
const failingNode = {
  id: "n_fail",
  type: "flow.subworkflow" as const,
  typeVersion: 1,
  position: { x: 200, y: 0 },
  data: { label: "fail", params: {} },
}
const triggerNode = {
  id: "n_start",
  type: "trigger.manual" as const,
  typeVersion: 1,
  position: { x: 0, y: 0 },
  data: { label: "start", params: {} },
}
const catchNode = {
  id: "n_catch",
  type: "flow.catch" as const,
  typeVersion: 1,
  position: { x: 0, y: 200 },
  data: { label: "catch", params: {} },
}

function buildWorkflow(
  nodes: VisualWorkflow["nodes"],
  edges: VisualWorkflow["edges"] = [],
  onFailure?: { runCatchNodes?: boolean; notify?: boolean }
): VisualWorkflow {
  return {
    id: "wf_f",
    schemaVersion: 1,
    name: "fail wf",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      ...(onFailure ? { onFailure } : {}),
    },
  }
}

describe("findCatchNodes", () => {
  it("returns top-level flow.catch nodes only", () => {
    const wf = buildWorkflow([
      triggerNode,
      catchNode,
      { ...catchNode, id: "n_child_catch", parentId: "n_loop" },
    ])
    expect(findCatchNodes(wf).map((n) => n.id)).toEqual(["n_catch"])
  })
})

describe("terminal-failure catch phase (A1/A2)", () => {
  it("runs the catch node + downstream as a sub-run on terminal failure", async () => {
    const recoverNode = {
      id: "n_recover",
      type: "flow.set" as const,
      typeVersion: 1,
      position: { x: 200, y: 200 },
      data: {
        label: "recover",
        params: { variable: "recovered", value: "{{ $node['n_catch'].error.message }}" },
      },
    }
    const wf = buildWorkflow(
      [triggerNode, failingNode, catchNode, recoverNode],
      [
        { id: "e1", source: "n_start", target: "n_fail" },
        { id: "e2", source: "n_catch", target: "n_recover" },
      ]
    )

    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("failed")

    // Two runs: the main failed run + the spawned catch sub-run.
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(2)
    const subRun = runs.find((r) => r.id !== result.runId)!
    expect(subRun.status).toBe("succeeded")

    // The sub-run executed the catch node, surfacing the error envelope.
    const subEvents = await listRunEvents(subRun.id)
    const caught = subEvents.find((e) => e.type === "step_completed" && e.stepId === "n_catch")
    expect(caught).toBeDefined()
    const output = (caught?.payload as { output?: { caught?: boolean; error?: unknown } })?.output
    expect(output?.caught).toBe(true)
    // The recovery node also ran.
    expect(subEvents.some((e) => e.type === "step_completed" && e.stepId === "n_recover")).toBe(
      true
    )
  })

  it("does NOT run catch nodes when onFailure.runCatchNodes is false", async () => {
    const wf = buildWorkflow(
      [triggerNode, failingNode, catchNode],
      [{ id: "e1", source: "n_start", target: "n_fail" }],
      { runCatchNodes: false }
    )
    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("failed")
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(1) // no catch sub-run
  })

  it("appends a notify event when onFailure.notify is true", async () => {
    const wf = buildWorkflow(
      [triggerNode, failingNode],
      [{ id: "e1", source: "n_start", target: "n_fail" }],
      { runCatchNodes: false, notify: true }
    )
    const result = await runWorkflow({ workflow: wf, trigger })
    const events = await listRunEvents(result.runId)
    const notice = events.find(
      (e) => (e.payload as { data?: { notify?: boolean } } | undefined)?.data?.notify === true
    )
    expect(notice).toBeDefined()
  })

  it("does not recurse when the catch path itself fails (suppressCatch)", async () => {
    // catch → another failing subworkflow. The catch sub-run carries
    // suppressCatch, so it must NOT spawn a third run.
    const wf = buildWorkflow(
      [
        triggerNode,
        failingNode,
        catchNode,
        { ...failingNode, id: "n_fail2", position: { x: 200, y: 200 } },
      ],
      [
        { id: "e1", source: "n_start", target: "n_fail" },
        { id: "e2", source: "n_catch", target: "n_fail2" },
      ]
    )
    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("failed")
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(2) // main + exactly one catch sub-run, no recursion
  })
})
