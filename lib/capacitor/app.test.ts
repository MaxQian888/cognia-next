/**
 * @jest-environment jsdom
 */
import { subscribeResume } from "./app"

describe("app.subscribeResume", () => {
  it("invokes the handler when the plugin emits a resume event", async () => {
    const remove = jest.fn()
    const captured: { fn: (() => void) | null } = { fn: null }
    const addListener = jest.fn(async (_event: string, handler: () => void) => {
      captured.fn = handler
      return { remove }
    })

    const onResume = jest.fn()
    const unsub = await subscribeResume(onResume, async () => ({ addListener }))

    captured.fn?.()
    expect(onResume).toHaveBeenCalledTimes(1)

    unsub()
    expect(remove).toHaveBeenCalled()
  })

  it("falls back to visibilitychange when the plugin is unavailable", async () => {
    const onResume = jest.fn()
    const unsub = await subscribeResume(onResume, async () => {
      throw new Error("plugin missing")
    })

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
    expect(onResume).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
    expect(onResume).toHaveBeenCalledTimes(1) // no extra call when hidden

    unsub()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
    expect(onResume).toHaveBeenCalledTimes(1) // no calls after unsubscribe
  })
})
