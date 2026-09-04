/**
 * @jest-environment jsdom
 */
import {
  detectInputCapabilities,
  detectPlatform,
  isCapacitor,
  isCliHost,
  isNativeMobile,
  isTauri,
} from "./detect"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

function setCapacitor(state: "native" | "web" | "absent" | "broken") {
  const w = window as unknown as Record<string, unknown>
  if (state === "absent") {
    delete w.Capacitor
    return
  }
  if (state === "broken") {
    w.Capacitor = {} // present but no isNativePlatform
    return
  }
  w.Capacitor = { isNativePlatform: () => state === "native" }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  delete (globalThis as Record<string, unknown>).__COGNIA_CLI__
  setTauri(false)
  setCapacitor("absent")
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  })
})

describe("detectPlatform", () => {
  it("returns 'headless' before inspecting the window shim", () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    setTauri(true)
    setCapacitor("native")

    expect(detectPlatform()).toBe("headless")
  })

  it("returns 'web' when window is undefined (SSR)", () => {
    const real = globalThis.window
    // @ts-expect-error simulate SSR
    globalThis.window = undefined
    expect(detectPlatform()).toBe("web")
    globalThis.window = real
  })

  it("returns 'tauri' when the Tauri marker is present", () => {
    setTauri(true)
    expect(detectPlatform()).toBe("tauri")
  })

  it("returns 'mobile' when Capacitor.isNativePlatform() === true", () => {
    setCapacitor("native")
    expect(detectPlatform()).toBe("mobile")
  })

  it("returns 'web' when Capacitor.isNativePlatform() === false", () => {
    setCapacitor("web")
    expect(detectPlatform()).toBe("web")
  })

  it("returns 'web' on a vanilla browser", () => {
    expect(detectPlatform()).toBe("web")
  })

  it("prefers 'tauri' over 'mobile' when both markers appear", () => {
    setTauri(true)
    setCapacitor("native")
    expect(detectPlatform()).toBe("tauri")
  })
})

describe("isTauri", () => {
  it("is false without the marker, true with it", () => {
    expect(isTauri()).toBe(false)
    setTauri(true)
    expect(isTauri()).toBe(true)
  })
})

describe("isCapacitor", () => {
  it("is false when absent / web / broken, true only when native", () => {
    expect(isCapacitor()).toBe(false)
    setCapacitor("web")
    expect(isCapacitor()).toBe(false)
    setCapacitor("broken")
    expect(isCapacitor()).toBe(false)
    setCapacitor("native")
    expect(isCapacitor()).toBe(true)
  })

  it("stays true even when the Tauri marker is also present (capacitor-keyed)", () => {
    setTauri(true)
    setCapacitor("native")
    expect(isCapacitor()).toBe(true)
  })
})

describe("isCliHost", () => {
  it("is false with no marker", () => {
    expect(isCliHost()).toBe(false)
  })

  it("is true only for the exact `true` marker", () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_CLI__ = "yes"
    expect(isCliHost()).toBe(false)
    ;(globalThis as Record<string, unknown>).__COGNIA_CLI__ = true
    expect(isCliHost()).toBe(true)
  })

  it("stays out of the platform vocabulary: the CLI is still `web` and not headless", () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_CLI__ = true

    // Deliberate. Sixty call sites branch on `detectPlatform()`, and the CLI
    // has always read as `web` there. The marker answers a narrower question
    // (this process owns a process table) and must not silently re-label the
    // runtime or borrow the headless host's server-backed behavior.
    expect(detectPlatform()).toBe("web")
    expect(isTauri()).toBe(false)
  })
})

describe("isNativeMobile", () => {
  it("follows detectPlatform precedence: false when Tauri also present", () => {
    setCapacitor("native")
    expect(isNativeMobile()).toBe(true)
    setTauri(true)
    expect(isNativeMobile()).toBe(false)
  })
})

describe("detectInputCapabilities", () => {
  it("assumes desktop-like when matchMedia is unavailable (SSR)", () => {
    expect(detectInputCapabilities()).toEqual({ hasHover: true, coarsePointer: false })
  })

  it("reads (hover: hover) and (pointer: coarse) from matchMedia", () => {
    const spy = jest.fn((q: string) => ({
      matches: q === "(pointer: coarse)", // touch device: coarse, no hover
    }))
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: spy,
    })
    expect(detectInputCapabilities()).toEqual({ hasHover: false, coarsePointer: true })
    expect(spy).toHaveBeenCalledWith("(hover: hover)")
    expect(spy).toHaveBeenCalledWith("(pointer: coarse)")
  })
})
