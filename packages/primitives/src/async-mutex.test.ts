import { createMutex } from "./async-mutex"

/** A manually-resolvable promise for deterministic ordering assertions. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createMutex", () => {
  it("returns the body's resolved value to the caller", async () => {
    const mutex = createMutex()
    await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42)
  })

  it("propagates the body's rejection to the caller", async () => {
    const mutex = createMutex()
    const err = new Error("boom")
    await expect(mutex.runExclusive(async () => Promise.reject(err))).rejects.toBe(err)
  })

  it("serializes sections — the second body does not start until the first settles", async () => {
    const mutex = createMutex()
    const order: string[] = []
    const gate = deferred<void>()

    const first = mutex.runExclusive(async () => {
      order.push("first:start")
      await gate.promise
      order.push("first:end")
    })
    const second = mutex.runExclusive(async () => {
      order.push("second:start")
    })

    // Let microtasks flush: first has started, second must be blocked.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(["first:start"])

    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["first:start", "first:end", "second:start"])
  })

  it("does not break the chain when an earlier section rejects", async () => {
    const mutex = createMutex()
    const order: string[] = []

    const failing = mutex.runExclusive(async () => {
      order.push("failing")
      throw new Error("nope")
    })
    const following = mutex.runExclusive(async () => {
      order.push("following")
      return "ok"
    })

    await expect(failing).rejects.toThrow("nope")
    await expect(following).resolves.toBe("ok")
    expect(order).toEqual(["failing", "following"])
  })

  it("preserves enqueue order across many sections", async () => {
    const mutex = createMutex()
    const order: number[] = []
    const tasks = Array.from({ length: 5 }, (_, i) =>
      mutex.runExclusive(async () => {
        await Promise.resolve()
        order.push(i)
      })
    )
    await Promise.all(tasks)
    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  it("reports isLocked while a section is in flight and clears afterward", async () => {
    const mutex = createMutex()
    expect(mutex.isLocked()).toBe(false)
    const gate = deferred<void>()
    const task = mutex.runExclusive(async () => {
      await gate.promise
    })
    expect(mutex.isLocked()).toBe(true)
    gate.resolve()
    await task
    // Allow the decrement continuation to flush.
    await Promise.resolve()
    await Promise.resolve()
    expect(mutex.isLocked()).toBe(false)
  })
})
