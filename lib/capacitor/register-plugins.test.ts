/**
 * @jest-environment jsdom
 */
import { registerNativePlugins } from "./register-plugins"

const logInfo = jest.fn()
const logWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    shell: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
  },
}))

type Win = typeof window & {
  Capacitor?: {
    isNativePlatform?: () => boolean
    PluginHeaders?: Array<{ name: string }>
    Plugins?: Record<string, unknown>
  }
  __TAURI_INTERNALS__?: unknown
}

function setMobile(headers: Array<{ name: string }>) {
  const w = window as Win
  delete w.__TAURI_INTERNALS__
  w.Capacitor = { isNativePlatform: () => true, PluginHeaders: headers, Plugins: {} }
}

afterEach(() => {
  const w = window as Win
  delete w.Capacitor
  delete w.__TAURI_INTERNALS__
  jest.clearAllMocks()
})

describe("registerNativePlugins", () => {
  it("skips off-mobile (web / Tauri) without touching registerFn", async () => {
    const w = window as Win
    delete w.Capacitor // detectNativePlatform → "web"
    const registerFn = jest.fn()
    const out = await registerNativePlugins({ registerFn, win: w })
    expect(out).toEqual({ kind: "skipped", registered: [], available: [] })
    expect(registerFn).not.toHaveBeenCalled()
  })

  it("registers every advertised PluginHeader on mobile", async () => {
    setMobile([{ name: "Camera" }, { name: "NativeSettings" }, { name: "App" }])
    const registerFn = jest.fn()
    const out = await registerNativePlugins({ registerFn, win: window as Win })
    expect(out).toEqual({
      kind: "registered",
      registered: ["Camera", "NativeSettings", "App"],
      available: ["Camera", "NativeSettings", "App"],
    })
    expect(registerFn).toHaveBeenCalledTimes(3)
    expect(registerFn).toHaveBeenCalledWith("Camera")
    expect(registerFn).toHaveBeenCalledWith("NativeSettings")
    expect(registerFn).toHaveBeenCalledWith("App")
  })

  it("reports unavailable when the native bridge exposed no PluginHeaders", async () => {
    const w = window as Win
    delete w.__TAURI_INTERNALS__
    w.Capacitor = { isNativePlatform: () => true } // mobile, but no headers
    const registerFn = jest.fn()
    const out = await registerNativePlugins({ registerFn, win: w })
    expect(out).toEqual({ kind: "unavailable", registered: [], available: [] })
    expect(registerFn).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalled()
  })

  it("continues past a plugin whose registration throws", async () => {
    setMobile([{ name: "Good" }, { name: "Bad" }, { name: "AlsoGood" }])
    const registerFn = jest.fn((name: string) => {
      if (name === "Bad") throw new Error("boom")
    })
    const out = await registerNativePlugins({ registerFn, win: window as Win })
    expect(out.kind).toBe("registered")
    expect(out.registered).toEqual(["Good", "AlsoGood"])
    expect(out.available).toEqual(["Good", "Bad", "AlsoGood"])
    expect(logWarn).toHaveBeenCalledWith(
      "capacitor: registerPlugin failed",
      expect.objectContaining({ plugin: "Bad" })
    )
  })

  it("logs a startup self-check with registered / available / missing", async () => {
    setMobile([{ name: "Camera" }, { name: "Bad" }])
    const registerFn = jest.fn((name: string) => {
      if (name === "Bad") throw new Error("x")
    })
    await registerNativePlugins({ registerFn, win: window as Win })
    expect(logInfo).toHaveBeenCalledWith("capacitor: native plugins registered", {
      registered: ["Camera"],
      available: ["Camera", "Bad"],
      missing: ["Bad"],
    })
  })

  it("falls back to the core loader's registerPlugin when none is injected", async () => {
    setMobile([{ name: "Camera" }])
    const registerPlugin = jest.fn()
    const coreLoader = jest.fn(async () => ({ registerPlugin }))
    const out = await registerNativePlugins({ coreLoader, win: window as Win })
    expect(coreLoader).toHaveBeenCalled()
    expect(registerPlugin).toHaveBeenCalledWith("Camera")
    expect(out.kind).toBe("registered")
  })

  it("defaults to globalThis.Capacitor when no win is injected", async () => {
    setMobile([{ name: "App" }]) // sets globalThis/window.Capacitor
    const registerFn = jest.fn()
    const out = await registerNativePlugins({ registerFn })
    expect(out.kind).toBe("registered")
    expect(registerFn).toHaveBeenCalledWith("App")
  })

  it("stringifies a non-Error thrown during registration", async () => {
    setMobile([{ name: "App" }])
    const registerFn = jest.fn(() => {
      throw "string failure" // non-Error throw
    })
    const out = await registerNativePlugins({ registerFn, win: window as Win })
    expect(out.registered).toEqual([])
    expect(logWarn).toHaveBeenCalledWith(
      "capacitor: registerPlugin failed",
      expect.objectContaining({ plugin: "App", error: "string failure" })
    )
  })

  it("stringifies a non-Error rejection from the core loader", async () => {
    setMobile([{ name: "App" }])
    const coreLoader = jest.fn(async () => {
      throw "no module" // non-Error rejection
    })
    const out = await registerNativePlugins({ coreLoader, win: window as Win })
    expect(out.kind).toBe("unavailable")
    expect(logWarn).toHaveBeenCalledWith(
      "capacitor: failed to load @capacitor/core registerPlugin",
      expect.objectContaining({ error: "no module" })
    )
  })

  it("loads the real @capacitor/core registerPlugin by default (no loader injected)", async () => {
    setMobile([{ name: "Camera" }])
    const out = await registerNativePlugins({ win: window as Win })
    expect(out.kind).toBe("registered")
    expect(out.registered).toEqual(["Camera"])
    // The real @capacitor/core registerPlugin populates window.Capacitor.Plugins.
    expect((window as Win).Capacitor?.Plugins?.Camera).toBeDefined()
  })

  it("reports unavailable when the core loader rejects", async () => {
    setMobile([{ name: "Camera" }])
    const coreLoader = jest.fn(async () => {
      throw new Error("no core")
    })
    const out = await registerNativePlugins({ coreLoader, win: window as Win })
    expect(out).toEqual({ kind: "unavailable", registered: [], available: ["Camera"] })
    expect(logWarn).toHaveBeenCalledWith(
      "capacitor: failed to load @capacitor/core registerPlugin",
      expect.objectContaining({ error: "no core" })
    )
  })
})
