import {
  registerNotificationCommand,
  hasNotificationCommand,
  dispatchNotificationCommand,
  __resetNotificationCommandsForTesting,
} from "./action-registry"

beforeEach(() => __resetNotificationCommandsForTesting())

describe("registerNotificationCommand", () => {
  it("registers a handler and reports presence", () => {
    expect(hasNotificationCommand("open")).toBe(false)
    registerNotificationCommand("open", () => {})
    expect(hasNotificationCommand("open")).toBe(true)
  })

  it("unregister removes only the matching handler", () => {
    const h = () => {}
    const off = registerNotificationCommand("open", h)
    registerNotificationCommand("open", () => {}) // replaces
    off() // should NOT remove the replacement (identity guard)
    expect(hasNotificationCommand("open")).toBe(true)
  })
})

describe("dispatchNotificationCommand", () => {
  it("invokes the handler with the context", async () => {
    const seen: unknown[] = []
    registerNotificationCommand("open", (ctx) => {
      seen.push(ctx)
    })
    await dispatchNotificationCommand({ notificationId: "n1", command: "open", args: { x: 1 } })
    expect(seen).toEqual([{ notificationId: "n1", command: "open", args: { x: 1 } }])
  })

  it("awaits async handlers", async () => {
    let done = false
    registerNotificationCommand("async", async () => {
      await Promise.resolve()
      done = true
    })
    await dispatchNotificationCommand({ notificationId: "n", command: "async" })
    expect(done).toBe(true)
  })

  it("no-ops (no throw) on an unknown command", async () => {
    await expect(
      dispatchNotificationCommand({ notificationId: "n", command: "missing" })
    ).resolves.toBeUndefined()
  })

  it("swallows handler errors", async () => {
    registerNotificationCommand("boom", () => {
      throw new Error("nope")
    })
    await expect(
      dispatchNotificationCommand({ notificationId: "n", command: "boom" })
    ).resolves.toBeUndefined()
  })
})
