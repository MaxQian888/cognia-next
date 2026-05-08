/**
 * @jest-environment jsdom
 */
import { detectNativePlatform, isMobile, makeDefaultLoader, withPlugin } from "./_shared"

describe("detectNativePlatform", () => {
  const originalWindow = globalThis.window
  afterEach(() => {
    globalThis.window = originalWindow
    delete (globalThis as { Capacitor?: unknown }).Capacitor
  })

  it("returns 'web' when window is undefined", () => {
    const realWindow = globalThis.window
    // @ts-expect-error simulate SSR
    globalThis.window = undefined
    expect(detectNativePlatform()).toBe("web")
    globalThis.window = realWindow
  })

  it("returns 'tauri' when __TAURI_INTERNALS__ is present", () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    expect(detectNativePlatform()).toBe("tauri")
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it("returns 'mobile' when Capacitor.isNativePlatform() === true", () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true } })
    expect(detectNativePlatform()).toBe("mobile")
    expect(isMobile()).toBe(true)
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  it("returns 'web' for plain browser", () => {
    expect(detectNativePlatform()).toBe("web")
    expect(isMobile()).toBe(false)
  })
})

describe("withPlugin", () => {
  it("returns 'unsupported' when loader rejects", async () => {
    const result = await withPlugin(
      async () => {
        throw new Error("module not found")
      },
      async () => "value"
    )
    expect(result).toEqual({ kind: "unsupported" })
  })

  it("returns 'error' when action throws", async () => {
    const result = await withPlugin(
      async () => ({}),
      async () => {
        throw new Error("boom")
      }
    )
    expect(result).toEqual({ kind: "error", message: "boom" })
  })

  it("returns the action result on success", async () => {
    const result = await withPlugin(
      async () => ({ method: () => 42 }),
      async (plugin) => plugin.method()
    )
    expect(result).toBe(42)
  })

  it("normalizes non-Error throws to string", async () => {
    const result = await withPlugin(
      async () => ({}),
      async () => {
        throw "string error"
      }
    )
    expect(result).toEqual({ kind: "error", message: "string error" })
  })
})

describe("makeDefaultLoader", () => {
  it("creates a loader that returns the named export", async () => {
    // We can't actually dynamic-import from jest, so we just confirm the
    // function shape is correct and rejects on missing module (caught by
    // withPlugin in real usage).
    const loader = makeDefaultLoader("@nonexistent/plugin", "Plugin")
    await expect(loader()).rejects.toBeDefined()
  })
})
