import { act, render, screen } from "@testing-library/react"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import { CursorEffectLayer, resolveEffectColor } from "./cursor-effect-layer"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_CURSOR, type CursorEffectKind, type CursorSettings } from "@/types/appearance"

jest.mock("@/lib/appearance/cursor/use-cursor-accent", () => ({
  useCursorAccentColor: jest.fn(() => "#7c3aed"),
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: jest.fn(() => ({ reduce: false, durationScale: 1 })),
}))

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"

const flowMotionMock = useFlowMotion as jest.Mock

const baseSettings = {
  id: "singleton" as const,
  permissionMode: "default" as const,
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

function setEffect(kind: CursorEffectKind, overrides: Partial<CursorSettings> = {}) {
  useSettingsStore.setState({
    settings: {
      ...baseSettings,
      cursor: {
        ...DEFAULT_CURSOR,
        ...overrides,
        effect: { ...DEFAULT_CURSOR.effect, kind, ...(overrides.effect ?? {}) },
      },
    },
  })
}

/** jsdom has no matchMedia; install one reporting the requested pointer type. */
function stubMatchMedia(coarse: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: coarse,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: jest.fn(() => mql),
  })
  return mql
}

/** jsdom canvases have no 2D context; return a stub so the loop can run. */
function stubCanvasContext() {
  const ctx = {
    clearRect: jest.fn(),
    setTransform: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    translate: jest.fn(),
    rotate: jest.fn(),
    beginPath: jest.fn(),
    closePath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    bezierCurveTo: jest.fn(),
    quadraticCurveTo: jest.fn(),
    arc: jest.fn(),
    fill: jest.fn(),
    stroke: jest.fn(),
    createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    globalCompositeOperation: "source-over",
  }
  jest
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    // The DOM lib types `getContext` as a union of per-contextId overloads, so
    // a single stub implementation never satisfies all of them.
    .mockImplementation((() => ctx) as unknown as HTMLCanvasElement["getContext"])
  return ctx
}

/**
 * Drive the rAF loop by hand. jsdom schedules `requestAnimationFrame` on a
 * ~16ms timer, so without this the component's very first frame never runs
 * inside the test and nothing is ever drawn.
 */
function stubRaf() {
  const pending: FrameRequestCallback[] = []
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    pending.push(cb)
    return pending.length
  })
  // Cancelling really drops the queued callback — otherwise "paused" and
  // "running" look identical to the test and the pause path proves nothing.
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    pending.length = 0
  })
  return {
    /** Run every callback queued so far, at `ts` milliseconds. */
    flush(ts = 16) {
      const queued = pending.splice(0, pending.length)
      act(() => {
        for (const cb of queued) cb(ts)
      })
    },
    /**
     * Run frames until the loop stops queueing more (or `limit` is hit). The
     * component clamps each frame's delta, so a single huge timestamp does not
     * retire the field — real time has to pass, one frame at a time.
     */
    runUntilParked(limit = 400): number {
      let frames = 0
      let ts = 16
      while (pending.length > 0 && frames < limit) {
        ts += 64
        const queued = pending.splice(0, pending.length)
        act(() => {
          for (const cb of queued) cb(ts)
        })
        frames++
      }
      return frames
    },
    pendingCount: () => pending.length,
  }
}

beforeEach(() => {
  stubMatchMedia(false)
  flowMotionMock.mockReturnValue({ reduce: false, durationScale: 1 })
})

afterEach(() => {
  useSettingsStore.setState({ settings: null })
  jest.restoreAllMocks()
})

describe("resolveEffectColor", () => {
  const cursor = (overrides: Partial<CursorSettings["effect"]>): CursorSettings => ({
    ...DEFAULT_CURSOR,
    packId: "sakura",
    effect: { ...DEFAULT_CURSOR.effect, ...overrides },
  })

  it("returns null for rainbow — each particle carries its own hue", () => {
    expect(resolveEffectColor(cursor({ colorMode: "rainbow" }), "#7c3aed")).toBeNull()
  })

  it("follows the theme accent by default", () => {
    expect(resolveEffectColor(cursor({ colorMode: "accent" }), "#7c3aed")).toBe("#7c3aed")
  })

  it("borrows the selected pointer pack's accent", () => {
    expect(resolveEffectColor(cursor({ colorMode: "pack" }), "#7c3aed")).toBe("#ff5f9e")
  })

  it("falls back to the theme accent when the pack is the system cursor", () => {
    const systemCursor: CursorSettings = {
      ...DEFAULT_CURSOR,
      effect: { ...DEFAULT_CURSOR.effect, colorMode: "pack" },
    }
    expect(resolveEffectColor(systemCursor, "#7c3aed")).toBe("#7c3aed")
  })

  it("uses the custom color, and stays usable when none was picked yet", () => {
    expect(
      resolveEffectColor(cursor({ colorMode: "custom", customColor: "#00b894" }), "#7c3aed")
    ).toBe("#00b894")
    expect(resolveEffectColor(cursor({ colorMode: "custom" }), "#7c3aed")).toBe("#7c3aed")
  })

  it("still produces a color when the theme accent is unresolved", () => {
    expect(resolveEffectColor(cursor({ colorMode: "accent" }), undefined)).toBeTruthy()
    expect(resolveEffectColor(cursor({ colorMode: "custom" }), undefined)).toBeTruthy()
    const systemCursor: CursorSettings = {
      ...DEFAULT_CURSOR,
      effect: { ...DEFAULT_CURSOR.effect, colorMode: "pack" },
    }
    expect(resolveEffectColor(systemCursor, undefined)).toBeTruthy()
  })
})

describe("CursorEffectLayer", () => {
  it("renders nothing when no effect is selected", () => {
    setEffect("none")
    render(<CursorEffectLayer />)
    expect(screen.queryByTestId("cursor-effect-layer")).toBeNull()
  })

  it("renders a hidden, click-through canvas when an effect is selected", () => {
    stubCanvasContext()
    setEffect("sparkle")
    render(<CursorEffectLayer />)
    const canvas = screen.getByTestId("cursor-effect-layer")
    expect(canvas).toHaveAttribute("aria-hidden", "true")
    expect(canvas).toHaveAttribute("data-effect", "sparkle")
    expect(canvas.className).toContain("pointer-events-none")
  })

  it("stands down under reduced motion — the setting is about exactly this", () => {
    flowMotionMock.mockReturnValue({ reduce: true, durationScale: 1 })
    setEffect("sparkle")
    render(<CursorEffectLayer />)
    expect(screen.queryByTestId("cursor-effect-layer")).toBeNull()
  })

  it("stands down on a coarse pointer — a touch screen has no cursor to follow", () => {
    stubMatchMedia(true)
    setEffect("sparkle")
    render(<CursorEffectLayer />)
    expect(screen.queryByTestId("cursor-effect-layer")).toBeNull()
  })

  it("draws once the pointer moves", () => {
    const ctx = stubCanvasContext()
    const raf = stubRaf()
    setEffect("trail")
    render(<CursorEffectLayer />)
    // No pointer yet: the loop must be parked, not spinning on an empty field.
    raf.flush()
    expect(ctx.clearRect).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }))
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 90, clientY: 40 }))
    })
    raf.flush()
    expect(ctx.clearRect).toHaveBeenCalled()
    expect(ctx.fill).toHaveBeenCalled()
  })

  it("parks the loop once the field empties instead of running forever", () => {
    stubCanvasContext()
    const raf = stubRaf()
    setEffect("trail")
    render(<CursorEffectLayer />)
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }))
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 90, clientY: 40 }))
    })
    // Once every particle has outlived its lifetime the loop must stop
    // re-queueing itself — an idle window running a rAF timer forever is the
    // failure mode this whole layer is designed around.
    const frames = raf.runUntilParked()
    expect(frames).toBeLessThan(400)
    expect(raf.pendingCount()).toBe(0)
  })

  it("emits a click burst only when the setting allows it", () => {
    const ctx = stubCanvasContext()
    const raf = stubRaf()
    setEffect("ripple", { effect: { ...DEFAULT_CURSOR.effect, clickBurst: false, kind: "ripple" } })
    const { unmount } = render(<CursorEffectLayer />)
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 20 }))
    })
    raf.flush()
    expect(ctx.clearRect).not.toHaveBeenCalled()
    unmount()

    const ctx2 = stubCanvasContext()
    const raf2 = stubRaf()
    setEffect("ripple", { effect: { ...DEFAULT_CURSOR.effect, clickBurst: true, kind: "ripple" } })
    render(<CursorEffectLayer />)
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 20 }))
    })
    raf2.flush()
    expect(ctx2.clearRect).toHaveBeenCalled()
  })

  it("stops drawing the halo once the pointer leaves the window", () => {
    const ctx = stubCanvasContext()
    const raf = stubRaf()
    setEffect("glow")
    render(<CursorEffectLayer />)
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }))
    })
    raf.flush()
    expect(ctx.createRadialGradient).toHaveBeenCalled()

    ctx.createRadialGradient.mockClear()
    act(() => {
      window.dispatchEvent(new Event("pointerout"))
    })
    raf.flush(32)
    expect(ctx.createRadialGradient).not.toHaveBeenCalled()
  })

  it("pauses while the document is hidden and resumes with the field intact", () => {
    const ctx = stubCanvasContext()
    const raf = stubRaf()
    let hidden = false
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
    setEffect("trail")
    render(<CursorEffectLayer />)
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }))
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 90, clientY: 40 }))
    })
    raf.flush()
    ctx.clearRect.mockClear()

    act(() => {
      hidden = true
      document.dispatchEvent(new Event("visibilitychange"))
    })
    raf.flush()
    expect(ctx.clearRect).not.toHaveBeenCalled()

    act(() => {
      hidden = false
      document.dispatchEvent(new Event("visibilitychange"))
    })
    raf.flush()
    expect(ctx.clearRect).toHaveBeenCalled()
  })

  it("does not restart the loop on re-show when nothing is left to draw", () => {
    stubCanvasContext()
    const raf = stubRaf()
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false })
    setEffect("trail")
    render(<CursorEffectLayer />)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(raf.pendingCount()).toBe(0)
  })

  it("removes its window listeners on unmount", () => {
    stubCanvasContext()
    const remove = jest.spyOn(window, "removeEventListener")
    setEffect("trail")
    const { unmount } = render(<CursorEffectLayer />)
    unmount()
    const removed = remove.mock.calls.map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(["pointermove", "pointerdown", "resize"]))
  })

  it("renders nothing for a settings row written before this feature existed", () => {
    useSettingsStore.setState({ settings: { ...baseSettings } })
    render(<CursorEffectLayer />)
    expect(screen.queryByTestId("cursor-effect-layer")).toBeNull()
  })

  it("stands down on a runtime with no matchMedia at all", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: undefined,
    })
    setEffect("trail")
    render(<CursorEffectLayer />)
    expect(screen.queryByTestId("cursor-effect-layer")).toBeNull()
  })

  it("renders the canvas but starts no loop when the 2D context is unavailable", () => {
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation((() => null) as unknown as HTMLCanvasElement["getContext"])
    const raf = stubRaf()
    setEffect("trail")
    render(<CursorEffectLayer />)
    expect(screen.getByTestId("cursor-effect-layer")).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }))
    })
    expect(raf.pendingCount()).toBe(0)
  })

  it("clamps the backing store to 2x on an extreme device pixel ratio", () => {
    stubCanvasContext()
    stubRaf()
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 4 })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 })
    setEffect("trail")
    render(<CursorEffectLayer />)
    const canvas = screen.getByTestId("cursor-effect-layer") as HTMLCanvasElement
    expect(canvas.width).toBe(800)
  })

  it("resizes the backing store when the window changes size", () => {
    stubCanvasContext()
    stubRaf()
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 })
    setEffect("trail")
    render(<CursorEffectLayer />)
    const canvas = screen.getByTestId("cursor-effect-layer") as HTMLCanvasElement
    expect(canvas.width).toBe(400)
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 })
      window.dispatchEvent(new Event("resize"))
    })
    expect(canvas.width).toBe(900)
  })

  it("survives a matchMedia implementation that throws on the pointer query", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: jest.fn(() => {
        throw new Error("unsupported query")
      }),
    })
    stubCanvasContext()
    setEffect("trail")
    expect(() => render(<CursorEffectLayer />)).not.toThrow()
  })
})
