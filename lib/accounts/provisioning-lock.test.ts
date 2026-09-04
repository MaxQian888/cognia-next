/** @jest-environment jsdom */
import {
  __resetAccountProvisioningLocksForTests,
  withAccountProvisioningLock,
} from "./provisioning-lock"

const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks")

function setLockManager(value: unknown): void {
  Object.defineProperty(globalThis.navigator, "locks", {
    value,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  __resetAccountProvisioningLocksForTests()
  if (original) Object.defineProperty(globalThis.navigator, "locks", original)
  else Reflect.deleteProperty(globalThis.navigator as object, "locks")
})

describe("without Web Locks", () => {
  beforeEach(() => setLockManager(undefined))

  it("runs same-id sections one at a time", async () => {
    const events: string[] = []
    const gate = Promise.withResolvers<void>()

    const first = withAccountProvisioningLock("dev-local", async () => {
      events.push("a:enter")
      await gate.promise
      events.push("a:exit")
    })
    const second = withAccountProvisioningLock("dev-local", async () => {
      events.push("b:enter")
    })

    await Promise.resolve()
    expect(events).toEqual(["a:enter"])
    gate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(["a:enter", "a:exit", "b:enter"])
  })

  it("does not make different ids wait on each other", async () => {
    const gate = Promise.withResolvers<void>()
    const events: string[] = []

    const held = withAccountProvisioningLock("one", async () => {
      await gate.promise
      events.push("one")
    })
    await withAccountProvisioningLock("two", async () => {
      events.push("two")
    })

    expect(events).toEqual(["two"])
    gate.resolve()
    await held
  })

  it("lets the next waiter through after a section throws", async () => {
    const failed = withAccountProvisioningLock("dev-local", async () => {
      throw new Error("provision failed")
    })
    await expect(failed).rejects.toThrow("provision failed")
    await expect(withAccountProvisioningLock("dev-local", async () => "ok")).resolves.toBe("ok")
  })

  it("propagates the section's own rejection rather than swallowing it", async () => {
    await expect(
      withAccountProvisioningLock("dev-local", async () => {
        throw new TypeError("boom")
      })
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe("with Web Locks", () => {
  it("takes the named exclusive lock and returns the section's value", async () => {
    const request = jest.fn(async (_name: string, callback: () => Promise<unknown>) => callback())
    setLockManager({ request })

    await expect(withAccountProvisioningLock("dev-local", async () => "created")).resolves.toBe(
      "created"
    )
    expect(request).toHaveBeenCalledWith("cognia-account-provision:dev-local", expect.any(Function))
  })

  it("scopes the lock name to the account id", async () => {
    const request = jest.fn(async (_name: string, callback: () => Promise<unknown>) => callback())
    setLockManager({ request })

    await withAccountProvisioningLock("e2e", async () => undefined)
    expect(request).toHaveBeenCalledWith("cognia-account-provision:e2e", expect.any(Function))
  })
})
