/**
 * @jest-environment jsdom
 */
/**
 * The chain from a real `appendPlanEvent` to `dispatchTrigger`, driven through
 * the PRODUCTION emitter rather than the runner's injection hatch. A trigger
 * whose only proof is its own test hook is a trigger that can ship dormant.
 */
import "fake-indexeddb/auto"

const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

import { appendPlanEvent } from "@/lib/db/plans"
import { _seedTriggerSubscriptionsForTest } from "./trigger-subscriptions"
import { disposePlanEventTrigger, initPlanEventTrigger } from "./plan-event-trigger"

const PLAN_ID = "plan_1"

function seedWorkflow(params: Record<string, unknown>) {
  _seedTriggerSubscriptionsForTest([
    {
      id: "wf1",
      nodes: [{ id: "t1", type: "trigger.plan.event", data: { params } }],
    },
  ] as never)
}

/** Let the bus microtask and the runner's dynamic imports settle. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

beforeEach(async () => {
  jest.clearAllMocks()
  const { getDb } = await import("@/lib/db/schema")
  await getDb().agentPlans.clear()
  await getDb().agentPlanEvents.clear()
  await getDb().agentPlans.put({
    id: PLAN_ID,
    title: "A plan",
    status: "approved",
    source: "manual",
    steps: [],
    totalSteps: 0,
    completedSteps: 0,
    createdAt: 1,
    updatedAt: 1,
  } as never)
})

afterEach(() => disposePlanEventTrigger())

it("carries a real appendPlanEvent through to a dispatched run", async () => {
  seedWorkflow({})
  initPlanEventTrigger()

  await appendPlanEvent({
    planId: PLAN_ID,
    kind: "approved",
    payload: { kind: "approved" } as never,
  })
  await settle()

  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    workflowId: "wf1",
    kind: "trigger.plan.event",
    triggerId: "t1",
    payload: expect.objectContaining({ kind: "approved", planId: PLAN_ID, title: "A plan" }),
  })
})

it("honours the node's kinds filter", async () => {
  seedWorkflow({ kinds: ["step_failed"] })
  initPlanEventTrigger()

  await appendPlanEvent({
    planId: PLAN_ID,
    kind: "approved",
    payload: { kind: "approved" } as never,
  })
  await settle()
  expect(dispatchTrigger).not.toHaveBeenCalled()

  await appendPlanEvent({
    planId: PLAN_ID,
    kind: "step_failed",
    payload: { kind: "step_failed", stepId: "s1", title: "One", error: "boom", attempt: 1 },
  })
  await settle()
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
})
