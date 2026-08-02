import { createTurnCancellation, errorForCancelReason, type CancelReason } from "./cancellation"

function fakeProc() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    handlers,
    on(event: string, handler: (...args: unknown[]) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return this
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
    emit(event: string) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler()
    },
  } as unknown as Pick<NodeJS.Process, "on" | "off"> & {
    handlers: Map<string, Set<() => void>>
    emit: (event: string) => void
  }
}

describe("errorForCancelReason", () => {
  it.each([
    ["timeout", "timeout"],
    ["idle-timeout", "idle_timeout"],
    ["sigterm", "interrupted"],
    ["shutdown", "interrupted"],
    ["sigint", "cancelled"],
    ["abort", "cancelled"],
    ["rpc-cancel", "cancelled"],
    ["tool-cancel", "cancelled"],
  ] as const)("maps %s to %s", (reason, code) => {
    expect(errorForCancelReason(reason).code).toBe(code)
  })

  it("uses the supplied detail as the message when present", () => {
    expect(errorForCancelReason("timeout", "ran 90s").message).toBe("ran 90s")
    expect(errorForCancelReason("timeout").message).toContain("wall-clock")
  })
})

describe("createTurnCancellation", () => {
  it("starts uncancelled with a live signal", () => {
    const scope = createTurnCancellation()
    expect(scope.cancelled).toBe(false)
    expect(scope.reason).toBeNull()
    expect(scope.detail).toBeNull()
    expect(scope.signal.aborted).toBe(false)
    expect(scope.toError()).toBeNull()
  })

  it("aborts the signal and reports the reason on cancel", () => {
    const scope = createTurnCancellation()
    scope.cancel("rpc-cancel", "client asked")
    expect(scope.cancelled).toBe(true)
    expect(scope.reason).toBe("rpc-cancel")
    expect(scope.detail).toBe("client asked")
    expect(scope.signal.aborted).toBe(true)
    expect(scope.toError()).toEqual({ code: "cancelled", message: "client asked" })
  })

  it("keeps the FIRST reason when a second cancellation races in", () => {
    const scope = createTurnCancellation()
    scope.cancel("timeout")
    scope.cancel("sigint")
    expect(scope.reason).toBe("timeout")
    expect(scope.toError()?.code).toBe("timeout")
  })

  it("adopts an already-aborted caller signal at construction", () => {
    const controller = new AbortController()
    controller.abort()
    const scope = createTurnCancellation({ signal: controller.signal })
    expect(scope.reason).toBe("abort")
  })

  it("follows a caller signal that aborts later", () => {
    const controller = new AbortController()
    const scope = createTurnCancellation({ signal: controller.signal })
    controller.abort()
    expect(scope.reason).toBe("abort")
  })
})

describe("deadlines", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("fires the wall-clock deadline as a timeout", () => {
    const scope = createTurnCancellation({ timeoutMs: 1000 })
    jest.advanceTimersByTime(999)
    expect(scope.cancelled).toBe(false)
    jest.advanceTimersByTime(2)
    expect(scope.toError()?.code).toBe("timeout")
  })

  it("ignores a non-positive deadline", () => {
    const scope = createTurnCancellation({ timeoutMs: 0, idleTimeoutMs: -1 })
    jest.advanceTimersByTime(100_000)
    expect(scope.cancelled).toBe(false)
  })

  it("measures silence, not duration — activity resets the idle deadline", () => {
    const scope = createTurnCancellation({ idleTimeoutMs: 1000 })
    for (let i = 0; i < 5; i += 1) {
      jest.advanceTimersByTime(900)
      scope.noteActivity()
    }
    expect(scope.cancelled).toBe(false)
    jest.advanceTimersByTime(1001)
    expect(scope.toError()?.code).toBe("idle_timeout")
  })

  it("kills a busy turn on the wall clock, not the idle clock", () => {
    // Streaming steadily keeps the idle deadline permanently reset, so the only
    // thing that can stop a runaway-but-chatty turn is the wall clock.
    const scope = createTurnCancellation({ timeoutMs: 10_000, idleTimeoutMs: 1000 })
    for (let i = 0; i < 8; i += 1) {
      jest.advanceTimersByTime(900)
      scope.noteActivity()
    }
    expect(scope.cancelled).toBe(false)
    for (let i = 0; i < 4; i += 1) {
      jest.advanceTimersByTime(900)
      scope.noteActivity()
    }
    expect(scope.reason).toBe("timeout")
  })

  it("kills a stalled turn on the idle clock, well before the wall clock", () => {
    const scope = createTurnCancellation({ timeoutMs: 60_000, idleTimeoutMs: 1000 })
    jest.advanceTimersByTime(1_001)
    expect(scope.reason).toBe("idle-timeout")
  })

  it("clears both timers on cancel so nothing fires afterwards", async () => {
    const scope = createTurnCancellation({ timeoutMs: 1000, idleTimeoutMs: 500 })
    scope.cancel("rpc-cancel")
    jest.advanceTimersByTime(100_000)
    expect(scope.reason).toBe("rpc-cancel")
    await scope.finalize()
  })
})

describe("signal handlers", () => {
  it("maps SIGINT and SIGTERM onto their own reasons", () => {
    const procA = fakeProc()
    const sigint = createTurnCancellation({ handleSignals: true, proc: procA })
    procA.emit("SIGINT")
    expect(sigint.toError()?.code).toBe("cancelled")

    const procB = fakeProc()
    const sigterm = createTurnCancellation({ handleSignals: true, proc: procB })
    procB.emit("SIGTERM")
    expect(sigterm.toError()?.code).toBe("interrupted")
  })

  it("removes its handlers on finalize so a long-lived process does not leak them", async () => {
    const proc = fakeProc()
    const scope = createTurnCancellation({ handleSignals: true, proc })
    expect(proc.handlers.get("SIGINT")?.size).toBe(1)
    await scope.finalize()
    expect(proc.handlers.get("SIGINT")?.size).toBe(0)
    expect(proc.handlers.get("SIGTERM")?.size).toBe(0)
  })

  it("installs no handlers unless asked", () => {
    const proc = fakeProc()
    createTurnCancellation({ proc })
    expect(proc.handlers.size).toBe(0)
  })
})

describe("pending requests", () => {
  it("denies every outstanding waiter on cancellation, before the abort lands", () => {
    const order: string[] = []
    const scope = createTurnCancellation()
    scope.signal.addEventListener("abort", () => order.push("abort"))
    scope.onPendingRequest(() => order.push("deny-1"))
    scope.onPendingRequest(() => order.push("deny-2"))
    scope.cancel("sigint")
    expect(order).toEqual(["deny-1", "deny-2", "abort"])
  })

  it("denies waiters still parked at normal completion", async () => {
    const deny = jest.fn()
    const scope = createTurnCancellation()
    scope.onPendingRequest(deny)
    await scope.finalize()
    expect(deny).toHaveBeenCalledTimes(1)
  })

  it("does not deny a waiter that already resolved itself", () => {
    const deny = jest.fn()
    const scope = createTurnCancellation()
    const unregister = scope.onPendingRequest(deny)
    unregister()
    scope.cancel("abort")
    expect(deny).not.toHaveBeenCalled()
  })

  it("denies each waiter exactly once across cancel then finalize", async () => {
    const deny = jest.fn()
    const scope = createTurnCancellation()
    scope.onPendingRequest(deny)
    scope.cancel("abort")
    await scope.finalize()
    expect(deny).toHaveBeenCalledTimes(1)
  })

  it("keeps denying the rest when one waiter throws", () => {
    const deny = jest.fn()
    const scope = createTurnCancellation()
    scope.onPendingRequest(() => {
      throw new Error("waiter exploded")
    })
    scope.onPendingRequest(deny)
    expect(() => scope.cancel("abort")).not.toThrow()
    expect(deny).toHaveBeenCalledTimes(1)
  })
})

describe("teardown", () => {
  it("runs cleanups in reverse registration order", async () => {
    const order: string[] = []
    const scope = createTurnCancellation()
    scope.onCleanup(() => void order.push("first"))
    scope.onCleanup(() => void order.push("second"))
    scope.onCleanup(async () => void order.push("third"))
    await scope.finalize()
    expect(order).toEqual(["third", "second", "first"])
  })

  it("runs every remaining cleanup even when one throws", async () => {
    const lease = jest.fn()
    const scope = createTurnCancellation()
    scope.onCleanup(lease)
    scope.onCleanup(() => {
      throw new Error("sidecar refused to close")
    })
    scope.onCleanup(async () => {
      throw new Error("tool host hung")
    })
    await expect(scope.finalize()).resolves.toBeUndefined()
    expect(lease).toHaveBeenCalledTimes(1)
  })

  it("skips a cleanup that unregistered itself after completing normally", async () => {
    const cleanup = jest.fn()
    const scope = createTurnCancellation()
    const unregister = scope.onCleanup(cleanup)
    unregister()
    await scope.finalize()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it("is idempotent — a second finalize does nothing", async () => {
    const cleanup = jest.fn()
    const scope = createTurnCancellation()
    scope.onCleanup(cleanup)
    await scope.finalize()
    await scope.finalize()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it("tears down the same way for every cancellation cause", async () => {
    const reasons: CancelReason[] = [
      "abort",
      "sigint",
      "sigterm",
      "timeout",
      "idle-timeout",
      "rpc-cancel",
      "tool-cancel",
      "shutdown",
    ]
    for (const reason of reasons) {
      const cleanup = jest.fn()
      const deny = jest.fn()
      const scope = createTurnCancellation()
      scope.onCleanup(cleanup)
      scope.onPendingRequest(deny)
      scope.cancel(reason)
      await scope.finalize()
      expect(deny).toHaveBeenCalledTimes(1)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(scope.signal.aborted).toBe(true)
    }
  })
})
