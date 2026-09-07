/**
 * @jest-environment jsdom
 */
/**
 * Unit-level behaviour of the runner. The production chain from `createMemory`
 * through to a dispatched run lives in the sibling `.live.test.ts`.
 */
const dispatchTrigger = jest.fn(async (_i: unknown) => undefined)
jest.mock("./trigger-bridge", () => ({ dispatchTrigger: (i: unknown) => dispatchTrigger(i) }))

const findMatchingWorkflows = jest.fn((_k: string, _c: unknown) => [
  { workflowId: "wf1", nodeId: "t1", params: {} },
])
jest.mock("./trigger-subscriptions", () => ({
  findMatchingWorkflows: (k: string, c: unknown) => findMatchingWorkflows(k, c),
}))

import {
  _injectMemoryWrittenForTest,
  disposeMemoryWrittenTrigger,
  initMemoryWrittenTrigger,
} from "./memory-written-trigger"
import type { MemoryWrittenEvent } from "@/lib/memory/memory-event-bus"

function event(over: Partial<MemoryWrittenEvent> = {}): MemoryWrittenEvent {
  return {
    memoryId: "m1",
    type: "semantic",
    scope: "global",
    provenance: "explicit",
    importance: 8,
    at: 1000,
    ...over,
  } as MemoryWrittenEvent
}

beforeEach(() => {
  jest.clearAllMocks()
  findMatchingWorkflows.mockReturnValue([{ workflowId: "wf1", nodeId: "t1", params: {} }])
  initMemoryWrittenTrigger()
})

afterEach(() => disposeMemoryWrittenTrigger())

it("passes the classification to the matcher so a node can filter on it", async () => {
  await _injectMemoryWrittenForTest(event({ key: "always-x", agentId: "a1" }))
  expect(findMatchingWorkflows.mock.calls[0][1]).toMatchObject({
    memoryType: "semantic",
    memoryScope: "global",
    memoryProvenance: "explicit",
    importance: 8,
    memoryKey: "always-x",
    agentId: "a1",
  })
})

it("refuses the workflow that asked for the write", async () => {
  await _injectMemoryWrittenForTest(event({ origin: { workflowId: "wf1" } }))
  expect(dispatchTrigger).not.toHaveBeenCalled()
})

it("carries the origin's chain depth forward", async () => {
  await _injectMemoryWrittenForTest(event({ origin: { workflowId: "other", chainDepth: 3 } }))
  expect(dispatchTrigger.mock.calls[0][0]).toMatchObject({
    payload: expect.objectContaining({ chainDepth: 4 }),
  })
})

it("does nothing once disposed", async () => {
  disposeMemoryWrittenTrigger()
  await _injectMemoryWrittenForTest(event())
  expect(dispatchTrigger).not.toHaveBeenCalled()
})
