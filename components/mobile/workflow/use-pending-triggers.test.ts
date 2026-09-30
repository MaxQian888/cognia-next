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
    accountId: "acct_mobile",
    targetId: "mobile-companion",
  }) as MobileOutboundJobRow

beforeEach(() => {
  liveValue = undefined
  toArray.mockReset()
})

test("returns an empty map before the query resolves", () => {
  liveValue = undefined
  const { result } = renderHook(() => usePendingWorkflowTriggers())
  expect(result.current.size).toBe(0)
})

test("reports pending jobs as queued and claimed ones as sending, and nothing else", () => {
  liveValue = [
    job("a", "pending"),
    job("b", "sending"),
    job("c", "sent"),
    job("d", "failed"),
    job("e", "deadlettered"),
  ]
  const { result } = renderHook(() => usePendingWorkflowTriggers())
  expect([...result.current.entries()].sort()).toEqual([
    ["a", "queued"],
    ["b", "sending"],
  ])
})

test("lets a sending row win over a queued one for the same workflow, in either order", () => {
  liveValue = [job("w", "pending"), { ...job("w", "sending"), id: "w-2" }, job("v", "sending")]
  const first = renderHook(() => usePendingWorkflowTriggers())
  expect(first.result.current.get("w")).toBe("sending")
  liveValue = [job("v", "sending"), { ...job("w", "sending"), id: "w-2" }, job("w", "pending")]
  const second = renderHook(() => usePendingWorkflowTriggers())
  expect(second.result.current.get("w")).toBe("sending")
  expect(second.result.current.get("v")).toBe("sending")
})

test("ignores rows with a non-string workflowId payload", () => {
  liveValue = [job(undefined, "pending"), job(42, "sending"), job("ok", "pending")]
  const { result } = renderHook(() => usePendingWorkflowTriggers())
  expect([...result.current.keys()]).toEqual(["ok"])
})
