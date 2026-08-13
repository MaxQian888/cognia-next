import { reconnectDelayMs, waitForReconnectDelay } from "./reconnect-delay"

describe("CLI reconnect delay", () => {
  it("shares the bounded bridge schedule", () => {
    expect([0, 1, 2, 3, 4, 5].map((attempt) => reconnectDelayMs(attempt, 1))).toEqual([
      250, 1_000, 4_000, 16_000, 30_000, 30_000,
    ])
    expect(reconnectDelayMs(0, 0)).toBe(125)
    expect(reconnectDelayMs(-2.5, -1)).toBe(125)
    expect(reconnectDelayMs(1.8, 2)).toBe(1_000)
  })

  it("cancels an in-flight wait", async () => {
    const controller = new AbortController()
    const waiting = waitForReconnectDelay(30_000, controller.signal)
    controller.abort(new Error("stop"))
    await expect(waiting).rejects.toThrow("stop")
  })

  it("rejects an already-aborted wait and resolves an ordinary delay", async () => {
    const controller = new AbortController()
    controller.abort("stop")
    await expect(waitForReconnectDelay(1, controller.signal)).rejects.toThrow("reconnect cancelled")
    const inFlight = new AbortController()
    const cancelled = waitForReconnectDelay(30_000, inFlight.signal)
    inFlight.abort("stop")
    await expect(cancelled).rejects.toThrow("reconnect cancelled")
    await expect(waitForReconnectDelay(1)).resolves.toBeUndefined()
  })
})
