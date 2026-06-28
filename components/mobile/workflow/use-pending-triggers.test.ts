/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

import { usePendingWorkflowTriggers } from "./use-pending-triggers"

let liveValue: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (factory: () => unknown) => {
    void factory
    return liveValue
  },
}))

const toArray = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    mobileOutboundQueue: {
      where: () => ({ equals: () => ({ toArray }) }),
    },
  }),
}))

const job = (
  workflowId: unknown,
  status: MobileOutboundJobRow["status"]
): MobileOutboundJobRow =>
  ({
    id: `${String(workflowId)}-${status}`,
    command: "workflow_trigger_manual",
    payload: { workflowId },
    status,
    attempts: 0,
    createdAt: 0,
    nextAttemptAt: 0,
    idempotencyKey: "k",
  }) as MobileOutboundJobRow

beforeEach(() => {
  liveValue = undefined
  toArray.mockReset()
})

test("returns an empty set before the query resolves", () => {
  liveValue = undefined
  const { result } = renderHook(() => usePendingWorkflowTriggers())
  expect(result.current.size).toBe(0)
})

test("collects workflow ids for pending and sending jobs only", () => {
  liveValue = [
    job("a", "pending"),
    job("b", "sending"),
    job("c", "sent"),
    job("d", "failed"),
    job("e", "deadlettered"),
  ]
  const { result } = renderHook(() => usePendingWorkflowTriggers())
  expect([...result.current].sort()).toEqual(["a", "b"])
})

test("ignores rows with a non-string workflowId payload", () => {
  liveValue = [job(undefined, "pending"), job(42, "sending"), job("ok", "pending")]
  const { result } = renderHook(() => usePendingWorkflowTriggers())
  expect([...result.current]).toEqual(["ok"])
})
