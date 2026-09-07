/** @jest-environment jsdom */

import { acquireExclusiveWebLock } from "./exclusive-web-lock"

type Grant = (lock: object | null) => Promise<void> | void

function installLockManager(behaviour: {
  onRequest: (name: string, options: { signal?: AbortSignal }, grant: Grant) => Promise<unknown>
}) {
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: { request: behaviour.onRequest },
  })
}

function removeLockManager() {
  Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: undefined })
}

afterEach(() => removeLockManager())

describe("acquireExclusiveWebLock", () => {
  it("resolves once the lock is granted and holds it until the signal aborts", async () => {
    let released = false
    installLockManager({
      onRequest: async (_name, _options, grant) => {
        await grant({})
        released = true
      },
    })
    const controller = new AbortController()

    expect(await acquireExclusiveWebLock("subsystem", controller.signal)).toBe(true)
    expect(released).toBe(false)

    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(released).toBe(true)
  })

  it("reports not-owned when this caller's own teardown withdrew the request", async () => {
    installLockManager({
      onRequest: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    })

    expect(await acquireExclusiveWebLock("subsystem", new AbortController().signal)).toBe(false)
  })

  it("does not block boot when Web Locks is missing", async () => {
    expect(await acquireExclusiveWebLock("subsystem", new AbortController().signal)).toBe(true)
  })

  it("does not block boot when the lock API itself fails", async () => {
    installLockManager({ onRequest: () => Promise.reject(new Error("lock manager exploded")) })

    expect(await acquireExclusiveWebLock("subsystem", new AbortController().signal)).toBe(true)
  })

  it("refuses immediately for an already-aborted signal", async () => {
    installLockManager({ onRequest: async (_n, _o, grant) => void (await grant({})) })
    const controller = new AbortController()
    controller.abort()

    expect(await acquireExclusiveWebLock("subsystem", controller.signal)).toBe(false)
  })

  it("passes the caller's name and signal through to the lock manager", async () => {
    const seen: { name?: string; hasSignal?: boolean } = {}
    installLockManager({
      onRequest: async (name, options, grant) => {
        seen.name = name
        seen.hasSignal = options.signal !== undefined
        await grant({})
      },
    })
    const controller = new AbortController()

    await acquireExclusiveWebLock("cognia-bot-runtime", controller.signal)
    controller.abort()

    expect(seen).toEqual({ name: "cognia-bot-runtime", hasSignal: true })
  })
})
