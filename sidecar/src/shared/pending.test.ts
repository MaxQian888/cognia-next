import test from "node:test"
import assert from "node:assert/strict"
import { awaitPending, settlePending, drainPending } from "./pending.ts"
import type { PendingEntry } from "./pending.ts"

test("pending registration is synchronous and late replies cannot settle twice", async () => {
  const pending = new Map<string, PendingEntry<string>>()
  let cleaned = 0
  const promise = awaitPending(pending, "one", { onSettled: () => cleaned++ })
  assert.equal(pending.size, 1)
  assert.equal(settlePending(pending, "one", "answer"), true)
  assert.equal(settlePending(pending, "one", "late"), false)
  assert.equal(await promise, "answer")
  assert.equal(cleaned, 1)
})
test("timeout can resolve a fallback or reject and always removes its waiter", async () => {
  const pending = new Map<string, PendingEntry<string>>()
  assert.equal(
    await awaitPending(pending, "fallback", { timeoutMs: 1, onTimeout: () => "fallback" }),
    "fallback"
  )
  await assert.rejects(
    awaitPending(pending, "error", {
      timeoutMs: 1,
      onTimeout: () => {
        throw new Error("deadline")
      },
    }),
    /deadline/
  )
  assert.equal(pending.size, 0)
})
test("drain survives notification and resolver failures", () => {
  let answered = false
  const pending = new Map<string, PendingEntry<string>>([
    [
      "bad",
      {
        resolve() {
          throw new Error("foreign")
        },
      },
    ],
    [
      "good",
      {
        resolve(value) {
          answered = value === "closed"
        },
      },
    ],
  ])
  drainPending(pending, "closed", () => {
    throw new Error("notifier")
  })
  assert.equal(answered, true)
  assert.equal(pending.size, 0)
})
