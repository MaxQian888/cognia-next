/**
 * @jest-environment jsdom
 */
/**
 * Unit-level behaviour of the runner. The production chain from
 * `appendPlanEvent` through to a dispatched run lives in the sibling
 * `.live.test.ts`, which is what proves the trigger is not dormant.
 */
const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

const findMatchingWorkflows = jest.fn((_k: string, _c: unknown) => [
  { workflowId: "wf1", nodeId: "t1", params: {} },
])
jest.mock("./trigger-subscriptions", () => ({
  findMatchingWorkflows: (k: string, c: unknown) => findMatchingWorkflows(k, c),
}))

const getPlan = jest.fn(async (_id: string): Promise<unknown> => ({
  id: "p1",
  title: "A plan",
  status: "executing",
  source: "manual",
  totalSteps: 3,
  completedSteps: 1,
}))
jest.mock("@/lib/db/plans", () => ({ getPlan: (id: string) => getPlan(id) }))

import {
  _injectPlanEventForTest,
  disposePlanEventTrigger,
  initPlanEventTrigger,
  notePlanCreatedByWorkflow,
} from "./plan-event-trigger"
import type { PlanEvent } from "@/types/agent/plan"

const EVENT = {
  id: "e1",
  planId: "p1",
  kind: "approved",
  ts: 1000,
  payload: { kind: "approved" },
} as PlanEvent

beforeEach(() => {
  jest.clearAllMocks()
  findMatchingWorkflows.mockReturnValue([{ workflowId: "wf1", nodeId: "t1", params: {} }])
  initPlanEventTrigger()
})

afterEach(() => disposePlanEventTrigger())

it("carries the plan's own fields alongside the event", async () => {
  await _injectPlanEventForTest(EVENT)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    payload: expect.objectContaining({
      planId: "p1",
      title: "A plan",
      status: "executing",
      totalSteps: 3,
      event: { kind: "approved" },
    }),
  })
})

it("still fires for a plan row it cannot read", async () => {
  // The trail entry is the fact. A missing plan row narrows the payload rather
  // than swallowing the event.
  getPlan.mockResolvedValue(undefined)
  await _injectPlanEventForTest(EVENT)
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    payload: expect.objectContaining({ planId: "p1" }),
  })
})

it("refuses to react to a plan its own dispatch created", async () => {
  notePlanCreatedByWorkflow("wf1", "p1")
  await _injectPlanEventForTest(EVENT)
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

it("does not refuse a plan a different workflow created", async () => {
  notePlanCreatedByWorkflow("wf2", "p1")
  await _injectPlanEventForTest(EVENT)
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
})

it("does nothing once disposed", async () => {
  disposePlanEventTrigger()
  await _injectPlanEventForTest(EVENT)
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

it("swallows a lookup failure rather than breaking the bus", async () => {
  getPlan.mockRejectedValue(new Error("db is gone"))
  await expect(_injectPlanEventForTest(EVENT)).resolves.toBeUndefined()
})
