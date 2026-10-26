import {
  createLocalViewportScheduler,
  type LocalViewport,
  type LocalViewportResult,
} from "@/lib/browser/local-viewport-scheduler"

const viewport = (width = 800): LocalViewport => ({
  width,
  height: 600,
  deviceScaleFactor: 2,
  fitToWidth: true,
})

function deferred() {
  let resolve!: (result?: LocalViewportResult) => void
  const promise = new Promise<LocalViewportResult | void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms)
  await flush()
}

describe("createLocalViewportScheduler", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("dispatches the first measurement in a microtask and returns the synchronization result", async () => {
    const resize = jest.fn().mockResolvedValue({ frameSequence: 7 })
    const onRequest = jest.fn()
    const onApplied = jest.fn()
    const scheduler = createLocalViewportScheduler({
      sessionId: "first",
      resize,
      onRequest,
      onApplied,
    })
    scheduler.update(viewport())
    expect(resize).not.toHaveBeenCalled()
    await flush()
    expect(onRequest).toHaveBeenCalledWith(viewport())
    expect(resize).toHaveBeenCalledWith(viewport(), true)
    expect(onApplied).toHaveBeenCalledWith(viewport(), { frameSequence: 7 })
    scheduler.update(viewport(900))
    await advance(50)
    expect(resize).toHaveBeenLastCalledWith(viewport(900), false)
    scheduler.dispose()
  })

  it("sends bounded intermediate updates throughout a sustained 16 ms drag and the exact final size", async () => {
    const resize = jest.fn().mockResolvedValue(undefined)
    const scheduler = createLocalViewportScheduler({ sessionId: "drag", resize })
    scheduler.update(viewport())
    await flush()
    for (let tick = 1; tick <= 125; tick += 1) {
      scheduler.update(viewport(800 + tick))
      await advance(16)
      if (tick % 10 === 0) expect(resize.mock.calls.length).toBeGreaterThan(tick / 5)
    }
    await advance(50)
    expect(resize.mock.calls.length).toBeLessThanOrEqual(42)
    expect(resize).toHaveBeenLastCalledWith(viewport(925), false)
    scheduler.dispose()
  })

  it("serializes across remounts and invokes onRequest only at actual dispatch", async () => {
    const gate = deferred()
    const oldResize = jest.fn(() => gate.promise)
    const oldApplied = jest.fn()
    const first = createLocalViewportScheduler({
      sessionId: "remount",
      resize: oldResize,
      onApplied: oldApplied,
    })
    first.update(viewport())
    await flush()
    first.dispose()
    const resize = jest.fn().mockResolvedValue(undefined)
    const onRequest = jest.fn()
    const next = createLocalViewportScheduler({ sessionId: "remount", resize, onRequest })
    next.update(viewport(900))
    await flush()
    expect(oldResize).toHaveBeenCalledTimes(1)
    expect(resize).not.toHaveBeenCalled()
    expect(onRequest).not.toHaveBeenCalled()
    next.update(viewport(950))
    gate.resolve()
    await flush()
    expect(oldApplied).not.toHaveBeenCalled()
    expect(resize).toHaveBeenCalledTimes(1)
    expect(resize).toHaveBeenCalledWith(viewport(950), true)
    expect(onRequest).toHaveBeenCalledWith(viewport(950))
    next.dispose()
  })

  it("drops disposed queued generations without blocking their successors", async () => {
    const gate = deferred()
    const first = createLocalViewportScheduler({ sessionId: "queued", resize: () => gate.promise })
    first.update(viewport())
    await flush()
    const resize = jest.fn().mockResolvedValue(undefined)
    const onRequest = jest.fn()
    const queued = createLocalViewportScheduler({ sessionId: "queued", resize, onRequest })
    queued.update(viewport(900))
    await flush()
    queued.dispose()
    const lastResize = jest.fn().mockResolvedValue(undefined)
    const last = createLocalViewportScheduler({ sessionId: "queued", resize: lastResize })
    last.update(viewport(1000))
    gate.resolve()
    await flush()
    expect(resize).not.toHaveBeenCalled()
    expect(onRequest).not.toHaveBeenCalled()
    expect(lastResize).toHaveBeenCalledWith(viewport(1000), true)
    first.dispose()
    last.dispose()
  })

  it("coalesces in-flight measurements, skips unchanged values, and includes fit mode in equality", async () => {
    const gate = deferred()
    const resize = jest
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue(undefined)
    const onApplied = jest.fn()
    const scheduler = createLocalViewportScheduler({ sessionId: "coalesce", resize, onApplied })
    scheduler.update(viewport())
    await flush()
    scheduler.update(viewport(900))
    scheduler.update(viewport(950))
    await advance(100)
    expect(resize).toHaveBeenCalledTimes(1)
    gate.resolve({ frameSequence: 4 })
    await flush()
    expect(onApplied).toHaveBeenCalledWith(viewport(), { frameSequence: 4 })
    expect(resize).toHaveBeenLastCalledWith(viewport(950), false)
    scheduler.update(viewport(950))
    await advance(100)
    expect(resize).toHaveBeenCalledTimes(2)
    scheduler.update({ ...viewport(950), fitToWidth: false })
    await flush()
    expect(resize).toHaveBeenCalledTimes(3)
    scheduler.dispose()
  })

  it("cancels initial and throttled measurements when hidden", async () => {
    const resize = jest.fn().mockResolvedValue(undefined)
    const scheduler = createLocalViewportScheduler({ sessionId: "hidden", resize })
    scheduler.update(viewport())
    scheduler.update(null)
    await flush()
    expect(resize).not.toHaveBeenCalled()
    scheduler.update(viewport())
    await flush()
    scheduler.update(viewport(900))
    scheduler.update(null)
    await advance(100)
    expect(resize).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it("retries the final failed measurement without a new update and reports its error once", async () => {
    const error = new Error("transient resize")
    const resize = jest.fn().mockRejectedValueOnce(error).mockResolvedValue({ frameSequence: 9 })
    const onError = jest.fn()
    const onApplied = jest.fn()
    const scheduler = createLocalViewportScheduler({
      sessionId: "retry",
      resize,
      onError,
      onApplied,
    })
    scheduler.update(viewport())
    await flush()
    await advance(500)
    expect(resize).toHaveBeenCalledTimes(2)
    expect(resize).toHaveBeenLastCalledWith(viewport(), true)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onApplied).toHaveBeenCalledWith(viewport(), { frameSequence: 9 })
    scheduler.dispose()
  })

  it("caps retries at three and resets the budget for changed desired dimensions", async () => {
    const resize = jest.fn().mockRejectedValue(new Error("offline"))
    const onError = jest.fn()
    const scheduler = createLocalViewportScheduler({ sessionId: "cap", resize, onError })
    scheduler.update(viewport())
    await flush()
    await advance(5000)
    expect(resize).toHaveBeenCalledTimes(4)
    expect(onError).toHaveBeenCalledTimes(1)
    scheduler.update(viewport())
    await advance(5000)
    expect(resize).toHaveBeenCalledTimes(4)
    scheduler.update(viewport(900))
    await advance(5000)
    expect(resize).toHaveBeenCalledTimes(8)
    expect(onError).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })

  it("does not retain an old retry delay when the desired measurement changes", async () => {
    const resize = jest.fn().mockRejectedValue(new Error("offline"))
    const scheduler = createLocalViewportScheduler({ sessionId: "retry-change", resize })
    scheduler.update(viewport())
    await flush()
    await advance(50)
    expect(resize).toHaveBeenCalledTimes(2)
    scheduler.update(viewport(900))
    await advance(50)
    expect(resize).toHaveBeenCalledTimes(3)
    expect(resize).toHaveBeenLastCalledWith(viewport(900), true)
    scheduler.dispose()
    await advance(500)
    expect(resize).toHaveBeenCalledTimes(3)
  })

  it("suppresses failures and retries after disposal without blocking another session", async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    const resize = jest.fn(() => pending)
    const onError = jest.fn()
    const scheduler = createLocalViewportScheduler({ sessionId: "disposed-error", resize, onError })
    scheduler.update(viewport())
    await flush()
    const otherResize = jest.fn().mockResolvedValue(undefined)
    const other = createLocalViewportScheduler({ sessionId: "independent", resize: otherResize })
    other.update(viewport())
    await flush()
    expect(otherResize).toHaveBeenCalledTimes(1)
    scheduler.dispose()
    reject(new Error("late failure"))
    await flush()
    await advance(1000)
    expect(onError).not.toHaveBeenCalled()
    expect(resize).toHaveBeenCalledTimes(1)
    other.dispose()
  })

  it("restores an earlier desired size after a newer resize partially applies and fails", async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    const resize = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(undefined)
    const scheduler = createLocalViewportScheduler({ sessionId: "partial-failure", resize })
    scheduler.update(viewport())
    await flush()
    scheduler.update(viewport(900))
    await advance(50)
    scheduler.update(viewport())
    reject(new Error("viewport changed but fit failed"))
    await flush()
    await advance(50)
    expect(resize).toHaveBeenCalledTimes(3)
    expect(resize).toHaveBeenLastCalledWith(viewport(), false)
    scheduler.dispose()
  })
})
