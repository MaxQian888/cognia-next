import { createCodeServerOpenQueue } from "./open-file-queue"

/** Yield past a `setTimeout(fn, 0)` — the queue is driven by real timers. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise plus its resolve/reject, for holding an open() call in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it("sends a single request after the quiet period", async () => {
  const open = jest.fn().mockResolvedValue(undefined)
  const queue = createCodeServerOpenQueue(open, { delayMs: 0 })

  queue.request("src/a.ts", 12, 4)
  expect(open).not.toHaveBeenCalled()

  await tick()
  expect(open).toHaveBeenCalledWith("src/a.ts", 12, 4)
})

it("coalesces a burst down to the newest target", async () => {
  const open = jest.fn().mockResolvedValue(undefined)
  const queue = createCodeServerOpenQueue(open, { delayMs: 0 })

  queue.request("src/a.ts")
  queue.request("src/b.ts")
  queue.request("src/c.ts", 7)
  await tick()

  expect(open).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledWith("src/c.ts", 7, undefined)
})

it("never runs two opens concurrently and sends the latest once free", async () => {
  const first = deferred<void>()
  const open = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValue(Promise.resolve(undefined))
  const queue = createCodeServerOpenQueue(open, { delayMs: 0 })

  queue.request("src/a.ts")
  await tick()
  expect(open).toHaveBeenCalledTimes(1)

  // Two more arrive while the first call is still in flight.
  queue.request("src/b.ts")
  queue.request("src/c.ts")
  await tick()
  expect(open).toHaveBeenCalledTimes(1)

  first.resolve()
  await tick()

  expect(open).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenLastCalledWith("src/c.ts", undefined, undefined)
})

it("reports failures and keeps accepting later requests", async () => {
  const onError = jest.fn()
  const open = jest
    .fn()
    .mockRejectedValueOnce(new Error("not running"))
    .mockResolvedValue(undefined)
  const queue = createCodeServerOpenQueue(open, { delayMs: 0, onError })

  queue.request("src/a.ts")
  await tick()
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "not running" }))

  queue.request("src/b.ts")
  await tick()
  expect(open).toHaveBeenCalledTimes(2)
})

it("survives a rejection with no onError handler", async () => {
  const open = jest.fn().mockRejectedValue(new Error("boom"))
  const queue = createCodeServerOpenQueue(open, { delayMs: 0 })

  queue.request("src/a.ts")
  await tick()

  expect(open).toHaveBeenCalledTimes(1)
})

it("drops pending work on dispose and ignores later requests", async () => {
  const open = jest.fn().mockResolvedValue(undefined)
  const queue = createCodeServerOpenQueue(open, { delayMs: 0 })

  queue.request("src/a.ts")
  queue.dispose()
  await tick()
  expect(open).not.toHaveBeenCalled()

  queue.request("src/b.ts")
  await tick()
  expect(open).not.toHaveBeenCalled()
})

it("does not send a queued target when disposed mid-flight", async () => {
  const first = deferred<void>()
  const open = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
  const queue = createCodeServerOpenQueue(open, { delayMs: 0 })

  queue.request("src/a.ts")
  await tick()
  queue.request("src/b.ts")
  queue.dispose()

  first.resolve()
  await tick()

  expect(open).toHaveBeenCalledTimes(1)
})

it("defaults to a 150ms quiet period", async () => {
  const open = jest.fn().mockResolvedValue(undefined)
  const queue = createCodeServerOpenQueue(open)

  queue.request("src/a.ts")
  await tick()
  expect(open).not.toHaveBeenCalled()

  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(open).toHaveBeenCalledWith("src/a.ts", undefined, undefined)
})
