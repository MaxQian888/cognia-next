/**
 * @jest-environment jsdom
 */
/**
 * Driven through the PRODUCTION `createMemory`, not the runner's injection
 * hatch, so a broken publish shows up here rather than shipping dormant.
 */
import "fake-indexeddb/auto"

const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

import { createMemory } from "@/lib/db/memories"
import { _seedTriggerSubscriptionsForTest } from "./trigger-subscriptions"
import { disposeMemoryWrittenTrigger, initMemoryWrittenTrigger } from "./memory-written-trigger"

function seedWorkflow(id: string, params: Record<string, unknown>) {
  _seedTriggerSubscriptionsForTest([
    { id, nodes: [{ id: "t1", type: "trigger.memory.written", data: { params } }] },
  ] as never)
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

function memory(over: Record<string, unknown> = {}) {
  return {
    text: "The user's home address is 12 Somewhere Lane",
    type: "semantic",
    scope: "global",
    provenance: "explicit",
    importance: 7,
    ...over,
  } as never
}

beforeEach(async () => {
  jest.clearAllMocks()
  const { getDb } = await import("@/lib/db/schema")
  await getDb().memories.clear()
})

afterEach(() => disposeMemoryWrittenTrigger())

it("carries a real createMemory through to a dispatched run", async () => {
  seedWorkflow("wf1", {})
  initMemoryWrittenTrigger()

  await createMemory(memory())
  await settle()

  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    kind: "trigger.memory.written",
    payload: expect.objectContaining({ type: "semantic", scope: "global", importance: 7 }),
  })
})

it("never carries the memory text", async () => {
  // Long-term memory text is durable facts about the user, and there is no
  // safe subset of it. A future widening of the payload fails here.
  seedWorkflow("wf1", {})
  initMemoryWrittenTrigger()

  await createMemory(memory())
  await settle()

  const payload = JSON.stringify(dispatchTrigger.mock.calls[0][0])
  expect(payload).not.toContain("Somewhere Lane")
  expect(payload).not.toContain("home address")
})

it("filters on provenance, which is how an author says only what I captured", async () => {
  seedWorkflow("wf1", { provenances: ["explicit"] })
  initMemoryWrittenTrigger()

  await createMemory(memory({ provenance: "user" }))
  await settle()
  expect(dispatchTrigger).not.toHaveBeenCalled()

  await createMemory(memory({ provenance: "explicit" }))
  await settle()
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
})

it("refuses to fan a workflow's own write back to it", async () => {
  // The run-window drop covers writes made DURING a run. This covers the one
  // a run queued that lands after it ended.
  seedWorkflow("wf1", {})
  initMemoryWrittenTrigger()

  await createMemory(memory({ writeOrigin: { workflowId: "wf1", runId: "run1" } }))
  await settle()
  expect(dispatchTrigger).not.toHaveBeenCalled()

  await createMemory(memory({ writeOrigin: { workflowId: "other", runId: "run2" } }))
  await settle()
  expect(dispatchTrigger).toHaveBeenCalledTimes(1)
})

it("does not persist the write origin, which is event-only", async () => {
  seedWorkflow("wf1", {})
  initMemoryWrittenTrigger()
  const row = await createMemory(memory({ writeOrigin: { workflowId: "wf1" } }))
  expect((row as unknown as Record<string, unknown>).writeOrigin).toBeUndefined()
  const { getDb } = await import("@/lib/db/schema")
  const stored = await getDb().memories.get(row.id)
  expect((stored as unknown as Record<string, unknown>)?.writeOrigin).toBeUndefined()
})
