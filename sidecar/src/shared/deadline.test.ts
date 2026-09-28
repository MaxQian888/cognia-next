import test from "node:test"
import assert from "node:assert/strict"
import { raceDeadline } from "./deadline.ts"

test("returns work and preserves its rejection before the deadline", async () => {
  const timeout = () => {
    throw new Error("deadline should not fire")
  }
  assert.equal(await raceDeadline(Promise.resolve(7), 1000, timeout, { ref: true }), 7)
  const failure = new Error("work failed")
  await assert.rejects(
    raceDeadline(Promise.reject(failure), 1000, timeout, { ref: false }),
    failure
  )
})

test("settles at the deadline and consumes a later work rejection", async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<string>((_resolve, fail) => {
    reject = fail
  })
  assert.equal(await raceDeadline(pending, 1, () => "timed out", { ref: true }), "timed out")
  reject(new Error("late failure"))
  await new Promise<void>((resolve) => setImmediate(resolve))
})

test("propagates a throwing timeout handler", async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  try {
    await assert.rejects(
      raceDeadline(
        pending,
        1,
        () => {
          throw new Error("expired")
        },
        { ref: true }
      ),
      /expired/
    )
  } finally {
    resolve()
  }
})
