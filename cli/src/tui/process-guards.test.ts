import { installProcessCrashGuards, type ProcessLike } from "./process-guards"

function fakeProc() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  const proc: ProcessLike = {
    on(event: string, cb: (...a: unknown[]) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(cb)
      handlers.set(event, set)
      return proc
    },
    off(event: string, cb: (...a: unknown[]) => void) {
      handlers.get(event)?.delete(cb)
      return proc
    },
  } as unknown as ProcessLike
  const fire = (event: string, arg: unknown) => {
    for (const cb of handlers.get(event) ?? []) cb(arg)
  }
  const count = (event: string) => handlers.get(event)?.size ?? 0
  return { proc, fire, count }
}

describe("installProcessCrashGuards", () => {
  it("logs uncaughtException and unhandledRejection with distinct sources", () => {
    const { proc, fire } = fakeProc()
    const log = jest.fn()
    installProcessCrashGuards(log, proc)

    const err = new Error("async boom")
    fire("uncaughtException", err)
    fire("unhandledRejection", "rejected value")

    expect(log).toHaveBeenNthCalledWith(1, "uncaughtException", err)
    expect(log).toHaveBeenNthCalledWith(2, "unhandledRejection", "rejected value")
  })

  it("uninstall removes exactly the handlers it added", () => {
    const { proc, count } = fakeProc()
    const uninstall = installProcessCrashGuards(jest.fn(), proc)
    expect(count("uncaughtException")).toBe(1)
    expect(count("unhandledRejection")).toBe(1)
    uninstall()
    expect(count("uncaughtException")).toBe(0)
    expect(count("unhandledRejection")).toBe(0)
  })
})
