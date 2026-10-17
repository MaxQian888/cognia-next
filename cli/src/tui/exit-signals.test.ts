/**
 * @jest-environment node
 */
import { flushWithin, installTuiExitSignals, type SignalProcess } from "./exit-signals"
import { runInteractiveShell } from "../agent/run-shell"

function fakeProcess() {
  const listeners = new Map<string, Array<() => void>>()
  const exit = jest.fn()
  const proc: SignalProcess & { listenerCount(event: string): number } = {
    on: (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    off: (event, fn) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((candidate) => candidate !== fn)
      ),
    listenerCount: (event) => listeners.get(event)?.length ?? 0,
    exit,
  }
  const fire = (event: string) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn()
  }
  return { proc, exit, fire, listeners }
}

const settle = () => new Promise((r) => setImmediate(r))

describe("installTuiExitSignals", () => {
  it("flushes, restores the terminal, then exits with 128 + the signal number", async () => {
    const { proc, exit, fire } = fakeProcess()
    const order: string[] = []
    installTuiExitSignals({
      proc,
      flush: async () => {
        order.push("flush")
      },
      restore: () => order.push("restore"),
    })
    fire("SIGHUP")
    await settle()
    expect(order).toEqual(["flush", "restore"])
    expect(exit).toHaveBeenCalledWith(129)
  })

  it("maps SIGINT to 130 and SIGTERM to 143", async () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const { proc, exit, fire } = fakeProcess()
      installTuiExitSignals({ proc, flush: async () => {}, restore: () => {} })
      fire(signal)
      await settle()
      expect(exit).toHaveBeenCalledWith(code)
    }
  })

  it("exits on SIGINT despite an unrelated cleanup listener", async () => {
    const { proc, exit, fire } = fakeProcess()
    const flush = jest.fn(async () => {})
    proc.on("SIGINT", () => {}) // signal-exit / Ink cleanup, not a foreground shell
    installTuiExitSignals({ proc, flush, restore: () => {} })
    fire("SIGINT")
    await settle()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(130)
  })

  it("leaves SIGINT to the actual interactive shell until its child closes", async () => {
    const { proc, exit, fire } = fakeProcess()
    const flush = jest.fn(async () => {})
    let closeChild: (code: number | null) => void = () => {}
    const shell = runInteractiveShell("top", {
      spawn: () => ({
        on(event, callback) {
          if (event === "close") closeChild = callback
        },
      }),
    })
    installTuiExitSignals({ proc, flush, restore: () => {} })
    try {
      fire("SIGINT")
      await settle()
      expect(flush).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()
    } finally {
      closeChild(0)
      await shell
    }
    fire("SIGINT")
    await settle()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(130)
  })

  it("still exits when the flush fails, and reports the failure", async () => {
    const { proc, exit, fire } = fakeProcess()
    const onFlushError = jest.fn()
    installTuiExitSignals({
      proc,
      flush: async () => {
        throw new Error("ENOSPC")
      },
      restore: () => {},
      onFlushError,
    })
    fire("SIGTERM")
    await settle()
    expect(onFlushError).toHaveBeenCalledWith(expect.objectContaining({ message: "ENOSPC" }))
    expect(exit).toHaveBeenCalledWith(143)
  })

  it("lets a first-store flush finish within the normal exit budget", async () => {
    jest.useFakeTimers()
    const { proc, exit, fire } = fakeProcess()
    const restore = jest.fn()
    const onFlushError = jest.fn()
    installTuiExitSignals({
      proc,
      flush: () => new Promise((resolve) => setTimeout(resolve, 6_000)),
      restore,
      onFlushError,
    })
    try {
      fire("SIGINT")
      await jest.advanceTimersByTimeAsync(5_000)
      expect(exit).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1_000)
      expect(onFlushError).not.toHaveBeenCalled()
      expect(restore).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(130)
    } finally {
      await jest.runAllTimersAsync()
      jest.useRealTimers()
    }
  })

  it("exits at once on a second signal while the flush is still running", async () => {
    const { proc, exit, fire } = fakeProcess()
    installTuiExitSignals({
      proc,
      flush: () => new Promise(() => {}),
      restore: () => {},
      timeoutMs: 50,
    })
    fire("SIGTERM")
    fire("SIGINT")
    expect(exit).toHaveBeenCalledWith(130)
  })

  it("removes every handler on uninstall", () => {
    const { proc, listeners } = fakeProcess()
    const uninstall = installTuiExitSignals({ proc, flush: async () => {}, restore: () => {} })
    expect(proc.listenerCount("SIGTERM")).toBe(1)
    uninstall()
    expect([...listeners.values()].every((fns) => fns.length === 0)).toBe(true)
  })
})

describe("flushWithin", () => {
  it("resolves when the flush finishes in time", async () => {
    await expect(flushWithin(async () => {}, 50)).resolves.toBeUndefined()
  })

  it("rejects once the deadline passes", async () => {
    await expect(flushWithin(() => new Promise(() => {}), 5)).rejects.toThrow(
      "database flush did not finish within 5 ms"
    )
  })
})
