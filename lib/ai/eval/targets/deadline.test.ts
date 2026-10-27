import { createEvalDeadline } from "./deadline"

it("aborts a non-cooperative evaluation operation at its deadline", async () => {
  jest.useFakeTimers()
  const deadline = createEvalDeadline(undefined, 20)
  try {
    const outcome = deadline.run(() => new Promise<void>(() => {})).catch((error) => error)
    await jest.advanceTimersByTimeAsync(20)
    expect(await outcome).toMatchObject({
      name: "TimeoutError",
      message: "Evaluation deadline exceeded",
    })
    expect(deadline.signal.aborted).toBe(true)
  } finally {
    deadline.dispose()
    jest.useRealTimers()
  }
})

it("forwards caller cancellation and removes its listener after disposal", async () => {
  const caller = new AbortController()
  const deadline = createEvalDeadline(caller.signal)
  const reason = new Error("operator cancelled")
  const outcome = deadline.run(() => new Promise<void>(() => {})).catch((error) => error)
  caller.abort(reason)
  expect(await outcome).toBe(reason)
  expect(deadline.signal.reason).toBe(reason)
  deadline.dispose()
})

it("does not let a late successful result override cancellation in the same turn", async () => {
  const caller = new AbortController()
  const deadline = createEvalDeadline(caller.signal)
  const reason = new Error("cancelled before settlement")
  try {
    await expect(
      deadline.run(async () => {
        caller.abort(reason)
        return "late result"
      })
    ).rejects.toBe(reason)
  } finally {
    deadline.dispose()
  }
})
