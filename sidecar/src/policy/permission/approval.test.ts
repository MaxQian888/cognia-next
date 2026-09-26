import { test } from "node:test"
import assert from "node:assert/strict"

import { ABORTED_ANSWER, awaitApproval } from "./approval.ts"
import type { ApprovalAnswer, PendingApproval } from "./approval.ts"

/** What the host's permission_response handler does: forget the waiter, then settle it. */
function answer(pending: Map<string, PendingApproval>, requestId: string, reply: ApprovalAnswer) {
  const entry = pending.get(requestId)
  assert.ok(entry, `a waiter is parked under ${requestId}`)
  pending.delete(requestId)
  entry.resolve(reply)
}

test("parks the entry under the request id and resolves with the reply", async () => {
  const pending = new Map<string, PendingApproval>()
  const input = { a: 1 }
  const waiting = awaitApproval({
    pendingApprovals: pending,
    requestId: "r1",
    entry: { input, suggestions: ["s"] },
  })
  const entry = pending.get("r1")
  assert.ok(entry)
  assert.deepEqual(Object.keys(entry), ["resolve", "input", "suggestions"])
  assert.equal(entry.input, input)
  answer(pending, "r1", { behavior: "allow", updatedInput: { a: 2 } })
  assert.deepEqual(await waiting, { behavior: "allow", updatedInput: { a: 2 } })
})

test("review sees every reply first and may replace it", async () => {
  const pending = new Map<string, PendingApproval>()
  const seen: unknown[] = []
  const waiting = awaitApproval({
    pendingApprovals: pending,
    requestId: "r1",
    entry: { input: {} },
    review: (reply) => {
      seen.push(reply.behavior)
      return reply.behavior === "allow" ? { behavior: "deny", message: "rechecked" } : reply
    },
  })
  answer(pending, "r1", { behavior: "allow" })
  assert.deepEqual(await waiting, { behavior: "deny", message: "rechecked" })
  assert.deepEqual(seen, ["allow"])
})

test("an abort while waiting drops the entry, notifies, then settles as denied", async () => {
  const pending = new Map<string, PendingApproval>()
  const controller = new AbortController()
  const order: string[] = []
  const waiting = awaitApproval({
    pendingApprovals: pending,
    requestId: "r1",
    entry: { input: {} },
    signal: controller.signal,
    onAbort: () => order.push(`abort pending=${pending.size}`),
    review: (reply) => (order.push(`review ${String(reply.message)}`), reply),
  })
  controller.abort()
  assert.deepEqual(await waiting, ABORTED_ANSWER)
  assert.deepEqual(order, ["abort pending=0", "review aborted"])
  assert.equal(pending.size, 0)
})

test("an already-aborted signal settles at once", async () => {
  const pending = new Map<string, PendingApproval>()
  const aborted = new AbortController()
  aborted.abort()
  let notified = 0
  const outcome = await awaitApproval({
    pendingApprovals: pending,
    requestId: "r1",
    entry: { input: {} },
    signal: aborted.signal,
    onAbort: () => notified++,
  })
  assert.deepEqual(outcome, ABORTED_ANSWER)
  assert.equal(notified, 1)
  assert.equal(pending.size, 0)
})

test("a settled approval detaches from the signal, and a later abort changes nothing", async () => {
  const pending = new Map<string, PendingApproval>()
  const controller = new AbortController()
  let added = 0
  let removed = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
    added++
    add(...args)
  }) as typeof add
  controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    removed++
    remove(...args)
  }) as typeof remove
  let notified = 0
  const waiting = awaitApproval({
    pendingApprovals: pending,
    requestId: "r1",
    entry: { input: {} },
    signal: controller.signal,
    onAbort: () => notified++,
  })
  answer(pending, "r1", { behavior: "deny", message: "no" })
  assert.deepEqual(await waiting, { behavior: "deny", message: "no" })
  controller.abort()
  assert.deepEqual([added, removed, notified], [1, 1, 0])
})
