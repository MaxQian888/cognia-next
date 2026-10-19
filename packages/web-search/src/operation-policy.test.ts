import {
  createAttemptSignal,
  createOperationDeadline,
  isAbortLike,
  MAX_OPERATION_ATTEMPTS,
  OperationAdmission,
  OperationAdmissionError,
  OperationTimeoutError,
  READ_ATTEMPT_BUDGET_MS,
  READ_TOTAL_BUDGET_MS,
  SEARCH_TOTAL_BUDGET_MS,
  throwIfAborted,
} from "./operation-policy"

describe("operation budgets", () => {
  it("defines the shared bounds in one place", () => {
    expect(SEARCH_TOTAL_BUDGET_MS).toBe(30_000)
    expect(READ_TOTAL_BUDGET_MS).toBe(60_000)
    expect(READ_ATTEMPT_BUDGET_MS).toBe(20_000)
    expect(MAX_OPERATION_ATTEMPTS).toBe(3)
  })
})

describe("createOperationDeadline", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("aborts with a timeout reason when the budget elapses", () => {
    const deadline = createOperationDeadline(1000)
    expect(deadline.signal.aborted).toBe(false)
    jest.advanceTimersByTime(1000)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.signal.reason).toBeInstanceOf(OperationTimeoutError)
    expect(deadline.timedOut()).toBe(true)
    deadline.dispose()
  })

  it("follows the caller's cancellation without reporting a timeout", () => {
    const parent = new AbortController()
    const deadline = createOperationDeadline(1000, parent.signal)
    parent.abort(new Error("stop"))
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
    deadline.dispose()
  })

  it("starts aborted when the parent already is", () => {
    const parent = new AbortController()
    parent.abort()
    expect(createOperationDeadline(1000, parent.signal).signal.aborted).toBe(true)
  })

  it("reports the remaining budget against an injected clock", () => {
    let now = 0
    const deadline = createOperationDeadline(1000, undefined, () => now)
    now = 400
    expect(deadline.remaining()).toBe(600)
    now = 5000
    expect(deadline.remaining()).toBe(0)
    deadline.dispose()
  })

  it("does not fire after dispose", () => {
    const deadline = createOperationDeadline(1000)
    deadline.dispose()
    jest.advanceTimersByTime(2000)
    expect(deadline.signal.aborted).toBe(false)
  })

  it("bounds an attempt inside its parent", () => {
    const parent = new AbortController()
    const attempt = createAttemptSignal(parent.signal, 100)
    jest.advanceTimersByTime(100)
    expect(attempt.signal.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    attempt.dispose()
  })
})

describe("abort helpers", () => {
  it("recognizes abort- and timeout-shaped errors", () => {
    expect(isAbortLike(new DOMException("Aborted", "AbortError"))).toBe(true)
    expect(isAbortLike(new OperationTimeoutError())).toBe(true)
    expect(isAbortLike(new Error("The operation was aborted"))).toBe(true)
    expect(isAbortLike(new Error("HTTP 500"))).toBe(false)
    expect(isAbortLike(null)).toBe(false)
  })

  it("throws the signal's reason", () => {
    const c = new AbortController()
    throwIfAborted(c.signal)
    c.abort(new Error("why"))
    expect(() => throwIfAborted(c.signal)).toThrow("why")
  })
})

describe("OperationAdmission", () => {
  it("runs up to the concurrency limit and queues the rest in order", async () => {
    const admission = new OperationAdmission({ search: 1, read: 1 }, 2)
    const first = await admission.acquire("s", "read")
    const order: string[] = []
    const second = admission.acquire("s", "read").then((release) => {
      order.push("second")
      return release
    })
    const third = admission.acquire("s", "read").then((release) => {
      order.push("third")
      return release
    })
    expect(admission.stats("s", "read")).toEqual({ running: 1, waiting: 2 })
    first()
    const releaseSecond = await second
    releaseSecond()
    const releaseThird = await third
    releaseThird()
    expect(order).toEqual(["second", "third"])
    expect(admission.stats("s", "read")).toEqual({ running: 0, waiting: 0 })
  })

  it("refuses immediately when the queue is full", async () => {
    const admission = new OperationAdmission({ search: 1, read: 1 }, 1)
    await admission.acquire("s", "search")
    void admission.acquire("s", "search")
    await expect(admission.acquire("s", "search")).rejects.toBeInstanceOf(OperationAdmissionError)
  })

  it("isolates scopes and operation kinds", async () => {
    const admission = new OperationAdmission({ search: 1, read: 1 }, 0)
    await admission.acquire("a", "read")
    await expect(admission.acquire("b", "read")).resolves.toEqual(expect.any(Function))
    await expect(admission.acquire("a", "search")).resolves.toEqual(expect.any(Function))
  })

  it("drops a cancelled waiter without ever running it", async () => {
    const admission = new OperationAdmission({ search: 1, read: 1 }, 4)
    const release = await admission.acquire("s", "read")
    const c = new AbortController()
    const waiting = admission.acquire("s", "read", c.signal)
    c.abort()
    await expect(waiting).rejects.toThrow()
    expect(admission.stats("s", "read").waiting).toBe(0)
    release()
    expect(admission.stats("s", "read")).toEqual({ running: 0, waiting: 0 })
  })

  it("ignores a double release", async () => {
    const admission = new OperationAdmission({ search: 2, read: 2 }, 0)
    const release = await admission.acquire("s", "read")
    release()
    release()
    expect(admission.stats("s", "read").running).toBe(0)
  })
})
