/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (i: unknown) => dispatchTrigger(i),
}))

import { _seedTriggerSubscriptionsForTest } from "@/lib/workflow/runtime/trigger-subscriptions"
import {
  __resetTaskCompletionLinkageForTesting,
  dispatchScheduledTaskSettled,
} from "./task-completion-linkage"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

function seedWorkflow(params: Record<string, unknown>, id = "wf1") {
  _seedTriggerSubscriptionsForTest([
    {
      id,
      nodes: [{ id: "t1", type: "trigger.scheduler.taskCompleted", data: { params } }],
    },
  ] as never)
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task_1",
    name: "Nightly digest",
    type: "agent",
    projectId: "proj1",
    ...over,
  } as ScheduledTask
}

function execution(over: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "exec_1",
    taskId: "task_1",
    taskName: "Nightly digest",
    taskType: "agent",
    status: "completed",
    retryAttempt: 0,
    startedAt: new Date(1000),
    completedAt: new Date(2000),
    logs: [],
    ...over,
  } as TaskExecution
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetTaskCompletionLinkageForTesting()
})

it("fans a settled task out to a subscribed workflow", async () => {
  seedWorkflow({})
  await dispatchScheduledTaskSettled(task(), execution())
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    workflowId: "wf1",
    kind: "trigger.scheduler.taskCompleted",
    payload: expect.objectContaining({ taskId: "task_1", status: "completed", durationMs: null }),
  })
})

it("fires on failure, which is the case emitSchedulerEvent structurally cannot reach", async () => {
  // `emitSchedulerEvent` fires only on success and collapses the task type
  // into a hard-coded subset, so a failed task emits nothing there at all.
  seedWorkflow({ status: "failed" })
  await dispatchScheduledTaskSettled(
    task(),
    execution({ status: "failed", error: "boom", terminalReason: "executor-failure" })
  )
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    payload: expect.objectContaining({
      status: "failed",
      error: "boom",
      terminalReason: "executor-failure",
    }),
  })
})

it("refuses to re-trigger the workflow the task itself runs", async () => {
  // A workflow-type task that runs W, fanning out to W, is an unconditional
  // loop. Decidable from the payload, so it is rejected outright.
  seedWorkflow({})
  await dispatchScheduledTaskSettled(
    task({ type: "workflow", payload: { workflowId: "wf1" } as never }),
    execution({ taskType: "workflow" })
  )
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

it("still fires for a workflow-type task that runs a different workflow", async () => {
  seedWorkflow({})
  await dispatchScheduledTaskSettled(
    task({ type: "workflow", payload: { workflowId: "other" } as never }),
    execution({ taskType: "workflow" })
  )
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
})

it("honours the taskTypes and terminalReasons filters", async () => {
  seedWorkflow({ taskTypes: ["backup"] })
  await dispatchScheduledTaskSettled(task(), execution())
  expect(dispatchTrigger).not.toHaveBeenCalled()

  seedWorkflow({ terminalReasons: ["execution-timeout"] }, "wf2")
  await dispatchScheduledTaskSettled(task(), execution({ terminalReason: "execution-timeout" }))
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
})

it("never lets one workflow's failure block another", async () => {
  _seedTriggerSubscriptionsForTest([
    {
      id: "wfA",
      nodes: [{ id: "t1", type: "trigger.scheduler.taskCompleted", data: { params: {} } }],
    },
    {
      id: "wfB",
      nodes: [{ id: "t1", type: "trigger.scheduler.taskCompleted", data: { params: {} } }],
    },
  ] as never)
  dispatchTrigger.mockRejectedValueOnce(new Error("wfA is broken"))
  await expect(dispatchScheduledTaskSettled(task(), execution())).resolves.toBeUndefined()
  expect(dispatchTrigger).toHaveBeenCalledTimes(2)
})
