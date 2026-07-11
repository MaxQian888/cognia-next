/**
 * @jest-environment jsdom
 */
import { getAppInfo, minimizeApp, subscribeBackButton, subscribeResume } from "./app"

/** Full plugin double — the shape now requires backButton + minimizeApp. */
function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    addListener: jest.fn(async () => ({ remove: jest.fn() })),
    getInfo: jest.fn().mockResolvedValue({ name: "", version: "", build: "", id: "" }),
    minimizeApp: jest.fn().mockResolvedValue(undefined),
    ...overrides,
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  } as any
}

describe("app.getAppInfo", () => {
  it("returns the native info when the plugin resolves", async () => {
    const info = { name: "Cognia", version: "1.2.3", build: "456", id: "com.cognia.mobile" }
    const out = await getAppInfo(async () =>
      makeApp({ getInfo: jest.fn().mockResolvedValue(info) })
    )
    expect(out).toEqual({ kind: "ok", value: info })
  })

  it("returns unsupported when the plugin is unavailable", async () => {
    const out = await getAppInfo(async () => {
      throw new Error("web/tauri")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})

describe("app.subscribeResume", () => {
  it("invokes the handler when the plugin emits a resume event", async () => {
    const remove = jest.fn()
    const captured: { fn: (() => void) | null } = { fn: null }
    const addListener = jest.fn(async (_event: string, handler: () => void) => {
      captured.fn = handler
      return { remove }
    })

    const onResume = jest.fn()
    const unsub = await subscribeResume(onResume, async () => makeApp({ addListener }))

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

describe("app.subscribeBackButton", () => {
  it("registers a backButton listener and forwards canGoBack", async () => {
    const remove = jest.fn()
    const captured: { fn: ((e: { canGoBack: boolean }) => void) | null } = { fn: null }
    const addListener = jest.fn(
      async (_event: string, handler: (e: { canGoBack: boolean }) => void) => {
        captured.fn = handler
        return { remove }
      }
    )

    const onBack = jest.fn()
    const unsub = await subscribeBackButton(onBack, async () => makeApp({ addListener }))
    expect(addListener).toHaveBeenCalledWith("backButton", expect.any(Function))

    captured.fn?.({ canGoBack: true })
    expect(onBack).toHaveBeenCalledWith({ canGoBack: true })

    unsub()
    expect(remove).toHaveBeenCalled()
  })

  it("returns an inert unsubscribe when the plugin is unavailable", async () => {
    const onBack = jest.fn()
    const unsub = await subscribeBackButton(onBack, async () => {
      throw new Error("web/tauri")
    })
    expect(() => unsub()).not.toThrow()
    expect(onBack).not.toHaveBeenCalled()
  })
})

describe("app.minimizeApp", () => {
  it("calls the native minimizeApp", async () => {
    const p = makeApp()
    const out = await minimizeApp(async () => p)
    expect(out).toEqual({ kind: "ok", value: undefined })
    expect(p.minimizeApp).toHaveBeenCalled()
  })

  it("returns unsupported when the plugin is unavailable", async () => {
    const out = await minimizeApp(async () => {
      throw new Error("web/tauri")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})
