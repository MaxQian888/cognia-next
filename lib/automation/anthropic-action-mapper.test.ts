/**
 * Unit tests for the Anthropic action mapper. Mocks `desktop.*` and asserts
 * every action variant routes to the correct `desktop.*` call with the
 * right arguments + surface tagging.
 */

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    capabilities: jest.fn(),
    getFocus: jest.fn(),
    readTree: jest.fn(),
    find: jest.fn(),
    screenshot: jest.fn(),
    click: jest.fn(),
    type: jest.fn(),
    keys: jest.fn(),
    invokePattern: jest.fn(),
    mouseMove: jest.fn(),
    drag: jest.fn(),
    scroll: jest.fn(),
    holdKey: jest.fn(),
    mouseButton: jest.fn(),
    windowOp: jest.fn(),
    cursorPosition: jest.fn(),
    consentRespond: jest.fn(),
    auditSnapshot: jest.fn(),
    settingsGet: jest.fn(),
    settingsSet: jest.fn(),
    killSwitch: jest.fn(),
    virtualDisplayArm: jest.fn(),
  },
}))

import { desktop } from "@/lib/automation/client"
import type { AutomationSettings } from "@/lib/automation/client"
import { dispatchAnthropicAction, resetMapperState } from "./anthropic-action-mapper"
import { clearComputerUsePipState, getComputerUsePipSnapshot } from "./computer-use-pip"

const mockedDesktop = desktop as jest.Mocked<typeof desktop>
const ctx = { surface: "computerUse" as const }

/** Minimal settings stub — the mapper only reads `screenshotDedup`. */
function settingsWith(dedup: boolean): AutomationSettings {
  return { screenshotDedup: dedup } as AutomationSettings
}

function shot(
  bytes: string,
  width: number,
  height: number,
  source?: { width: number; height: number }
) {
  return {
    bytes,
    width,
    height,
    capturedAt: 0,
    format: "png" as const,
    ...(source ? { sourceWidth: source.width, sourceHeight: source.height } : {}),
  }
}

beforeEach(() => {
  // Default: settings resolve with dedup ON (the production default).
  mockedDesktop.settingsGet.mockResolvedValue(settingsWith(true))
})

afterEach(() => {
  resetMapperState()
  clearComputerUsePipState()
  jest.clearAllMocks()
})

describe("dispatchAnthropicAction", () => {
  it("screenshot returns bytes + dimensions", async () => {
    mockedDesktop.screenshot.mockResolvedValueOnce({
      bytes: "BASE64",
      width: 1280,
      height: 800,
      capturedAt: 0,
      format: "png",
    })

    const result = await dispatchAnthropicAction({ action: "screenshot" }, ctx)

    expect(mockedDesktop.screenshot).toHaveBeenCalledWith({}, ctx)
    expect(result).toEqual({
      ok: true,
      output: "BASE64",
      display_width_px: 1280,
      display_height_px: 800,
    })
  })

  it("publishes live activity and the latest frame for its chat session", async () => {
    mockedDesktop.screenshot.mockResolvedValueOnce(shot("FRAME", 1280, 800))

    await dispatchAnthropicAction(
      { action: "screenshot" },
      { surface: "computerUse", sessionKey: "session-1" }
    )

    expect(getComputerUsePipSnapshot("session-1")).toMatchObject({
      action: "screenshot",
      phase: "complete",
      frame: { src: "data:image/png;base64,FRAME", width: 1280, height: 800 },
    })
  })

  it("screen-off mode arms the virtual display before dispatching", async () => {
    mockedDesktop.virtualDisplayArm.mockResolvedValueOnce({
      status: "acquired",
      monitor: "\\\\.\\DISPLAY3",
      error: "",
    })
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    const result = await dispatchAnthropicAction(
      { action: "left_click", coordinate: [5, 6] },
      { surface: "computerUse", screenOffMode: true }
    )
    expect(mockedDesktop.virtualDisplayArm).toHaveBeenCalledTimes(1)
    expect(mockedDesktop.click).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it("screen-off mode fails strictly when the driver is unavailable", async () => {
    mockedDesktop.virtualDisplayArm.mockResolvedValueOnce({
      status: "unavailable",
      monitor: "",
      error: "driver not installed",
    })
    const result = await dispatchAnthropicAction(
      { action: "screenshot" },
      { surface: "computerUse", screenOffMode: true }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain("screen-off mode unavailable")
    // Strict: no capture is attempted on an unavailable driver.
    expect(mockedDesktop.screenshot).not.toHaveBeenCalled()
  })

  it("does not arm the virtual display when screen-off mode is off", async () => {
    mockedDesktop.screenshot.mockResolvedValueOnce({
      bytes: "X",
      width: 1,
      height: 1,
      capturedAt: 0,
      format: "png",
    })
    await dispatchAnthropicAction({ action: "screenshot" }, ctx)
    expect(mockedDesktop.virtualDisplayArm).not.toHaveBeenCalled()
  })

  it("left_click forwards left button, count 1", async () => {
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    const result = await dispatchAnthropicAction(
      { action: "left_click", coordinate: [10, 20] },
      ctx
    )
    expect(mockedDesktop.click).toHaveBeenCalledWith(
      { kind: "point", x: 10, y: 20 },
      { button: "left", count: 1 },
      ctx
    )
    expect(result.ok).toBe(true)
  })

  it("right_click forwards right button", async () => {
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "right_click", coordinate: [1, 2] }, ctx)
    expect(mockedDesktop.click).toHaveBeenCalledWith(
      { kind: "point", x: 1, y: 2 },
      { button: "right", count: 1 },
      ctx
    )
  })

  it("middle_click forwards middle button", async () => {
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "middle_click", coordinate: [3, 4] }, ctx)
    expect(mockedDesktop.click).toHaveBeenCalledWith(
      { kind: "point", x: 3, y: 4 },
      { button: "middle", count: 1 },
      ctx
    )
  })

  it("double_click sets double + count 2", async () => {
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "double_click", coordinate: [5, 6] }, ctx)
    expect(mockedDesktop.click).toHaveBeenCalledWith(
      { kind: "point", x: 5, y: 6 },
      { button: "left", double: true, count: 2 },
      ctx
    )
  })

  it("triple_click sets count 3", async () => {
    mockedDesktop.click.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "triple_click", coordinate: [7, 8] }, ctx)
    expect(mockedDesktop.click).toHaveBeenCalledWith(
      { kind: "point", x: 7, y: 8 },
      { button: "left", count: 3 },
      ctx
    )
  })

  it("mouse_move forwards coordinate as Point", async () => {
    mockedDesktop.mouseMove.mockResolvedValueOnce(undefined)
    const result = await dispatchAnthropicAction(
      { action: "mouse_move", coordinate: [42, 99] },
      ctx
    )
    expect(mockedDesktop.mouseMove).toHaveBeenCalledWith({ x: 42, y: 99 }, ctx)
    expect(result.ok).toBe(true)
  })

  it("left_click_drag passes from/to + left button", async () => {
    mockedDesktop.drag.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction(
      {
        action: "left_click_drag",
        start_coordinate: [0, 0],
        coordinate: [50, 60],
      },
      ctx
    )
    expect(mockedDesktop.drag).toHaveBeenCalledWith(
      { x: 0, y: 0 },
      { x: 50, y: 60 },
      { button: "left" },
      ctx
    )
  })

  it("left_mouse_down forwards down transition", async () => {
    mockedDesktop.mouseButton.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "left_mouse_down" }, ctx)
    expect(mockedDesktop.mouseButton).toHaveBeenCalledWith("left", "down", ctx)
  })

  it("left_mouse_up forwards up transition", async () => {
    mockedDesktop.mouseButton.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "left_mouse_up" }, ctx)
    expect(mockedDesktop.mouseButton).toHaveBeenCalledWith("left", "up", ctx)
  })

  describe("scroll", () => {
    it("up = negative dy * 120", async () => {
      mockedDesktop.scroll.mockResolvedValueOnce(undefined)
      await dispatchAnthropicAction(
        {
          action: "scroll",
          coordinate: [0, 0],
          scroll_direction: "up",
          scroll_amount: 2,
        },
        ctx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 0, y: 0 },
        { dy: -240 },
        ctx
      )
    })

    it("down = positive dy * 120", async () => {
      mockedDesktop.scroll.mockResolvedValueOnce(undefined)
      await dispatchAnthropicAction(
        {
          action: "scroll",
          coordinate: [10, 10],
          scroll_direction: "down",
          scroll_amount: 1,
        },
        ctx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 10, y: 10 },
        { dy: 120 },
        ctx
      )
    })

    it("left = negative dx", async () => {
      mockedDesktop.scroll.mockResolvedValueOnce(undefined)
      await dispatchAnthropicAction(
        {
          action: "scroll",
          coordinate: [0, 0],
          scroll_direction: "left",
          scroll_amount: 1,
        },
        ctx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 0, y: 0 },
        { dx: -120 },
        ctx
      )
    })

    it("right = positive dx", async () => {
      mockedDesktop.scroll.mockResolvedValueOnce(undefined)
      await dispatchAnthropicAction(
        {
          action: "scroll",
          coordinate: [0, 0],
          scroll_direction: "right",
          scroll_amount: 3,
        },
        ctx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 0, y: 0 },
        { dx: 360 },
        ctx
      )
    })
  })

  it("type forwards text", async () => {
    mockedDesktop.type.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "type", text: "hello" }, ctx)
    expect(mockedDesktop.type).toHaveBeenCalledWith("hello", {}, ctx)
  })

  it("key wraps text in KeyChord", async () => {
    mockedDesktop.keys.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "key", text: "Return" }, ctx)
    expect(mockedDesktop.keys).toHaveBeenCalledWith(["Return"], ctx)
  })

  it("hold_key converts seconds to milliseconds", async () => {
    mockedDesktop.holdKey.mockResolvedValueOnce(undefined)
    await dispatchAnthropicAction({ action: "hold_key", text: "Shift", duration: 0.5 }, ctx)
    expect(mockedDesktop.holdKey).toHaveBeenCalledWith(["Shift"], 500, ctx)
  })

  it("wait sleeps for the requested duration (in seconds) without Tauri", async () => {
    jest.useFakeTimers()
    try {
      const promise = dispatchAnthropicAction({ action: "wait", duration: 1 }, ctx)
      expect(mockedDesktop.mouseMove).not.toHaveBeenCalled()
      jest.advanceTimersByTime(1000)
      const result = await promise
      expect(result.ok).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it("cursor_position returns Point + serialized output", async () => {
    mockedDesktop.cursorPosition.mockResolvedValueOnce({ x: 100, y: 200 })
    const result = await dispatchAnthropicAction({ action: "cursor_position" }, ctx)
    expect(mockedDesktop.cursorPosition).toHaveBeenCalledWith(ctx)
    expect(result).toEqual({
      ok: true,
      output: JSON.stringify({ x: 100, y: 200 }),
      cursor: { x: 100, y: 200 },
    })
  })

  it("captures thrown errors into the result envelope", async () => {
    mockedDesktop.click.mockRejectedValueOnce(new Error("boom"))
    const result = await dispatchAnthropicAction({ action: "left_click", coordinate: [0, 0] }, ctx)
    expect(result).toEqual({ ok: false, error: "boom" })
  })

  it("captures non-Error throws", async () => {
    mockedDesktop.type.mockRejectedValueOnce("string-error")
    const result = await dispatchAnthropicAction({ action: "type", text: "x" }, ctx)
    expect(result).toEqual({ ok: false, error: "string-error" })
  })

  describe("screenshot dedup", () => {
    it("returns text for identical consecutive frames", async () => {
      mockedDesktop.screenshot.mockResolvedValue(shot("SAME", 10, 10))
      const sCtx = { ...ctx, sessionKey: "dedup-1" }
      const first = await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      expect(first.output).toBe("SAME")
      const second = await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      expect(second.ok).toBe(true)
      expect(second.output).toContain("unchanged")
      expect(second.display_width_px).toBeUndefined()
    })

    it("a successful driving action resets dedup", async () => {
      mockedDesktop.screenshot.mockResolvedValue(shot("SAME", 10, 10))
      mockedDesktop.click.mockResolvedValue(undefined)
      const sCtx = { ...ctx, sessionKey: "dedup-2" }
      await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      await dispatchAnthropicAction({ action: "left_click", coordinate: [1, 1] }, sCtx)
      const third = await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      expect(third.output).toBe("SAME")
    })

    it("dedup can be disabled via settings", async () => {
      mockedDesktop.settingsGet.mockResolvedValue(settingsWith(false))
      mockedDesktop.screenshot.mockResolvedValue(shot("SAME", 10, 10))
      const sCtx = { ...ctx, sessionKey: "dedup-3" }
      await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      const second = await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      expect(second.output).toBe("SAME")
    })

    it("dedup state is keyed per session", async () => {
      mockedDesktop.screenshot.mockResolvedValue(shot("SAME", 10, 10))
      await dispatchAnthropicAction({ action: "screenshot" }, { ...ctx, sessionKey: "a" })
      const otherSession = await dispatchAnthropicAction(
        { action: "screenshot" },
        { ...ctx, sessionKey: "b" }
      )
      expect(otherSession.output).toBe("SAME")
    })
  })

  describe("coordinate scaling", () => {
    it("scales click coordinates up when the screenshot was downscaled", async () => {
      mockedDesktop.screenshot.mockResolvedValueOnce(
        shot("X", 640, 360, { width: 1280, height: 720 })
      )
      mockedDesktop.click.mockResolvedValueOnce(undefined)
      const sCtx = { ...ctx, sessionKey: "scale-1" }
      await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      await dispatchAnthropicAction({ action: "left_click", coordinate: [320, 180] }, sCtx)
      expect(mockedDesktop.click).toHaveBeenCalledWith(
        { kind: "point", x: 640, y: 360 },
        expect.anything(),
        sCtx
      )
    })

    it("rejects out-of-bounds clicks without dispatching", async () => {
      mockedDesktop.screenshot.mockResolvedValueOnce(
        shot("X", 640, 360, { width: 1280, height: 720 })
      )
      const sCtx = { ...ctx, sessionKey: "scale-2" }
      await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      const r = await dispatchAnthropicAction(
        { action: "left_click", coordinate: [900, 100] },
        sCtx
      )
      expect(r.ok).toBe(false)
      expect(r.error).toContain("out of bounds")
      expect(mockedDesktop.click).not.toHaveBeenCalled()
    })

    it("scales drag endpoints and scroll targets", async () => {
      mockedDesktop.screenshot.mockResolvedValueOnce(
        shot("X", 100, 100, { width: 200, height: 200 })
      )
      mockedDesktop.drag.mockResolvedValueOnce(undefined)
      mockedDesktop.scroll.mockResolvedValueOnce(undefined)
      const sCtx = { ...ctx, sessionKey: "scale-3" }
      await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      await dispatchAnthropicAction(
        { action: "left_click_drag", start_coordinate: [10, 10], coordinate: [50, 50] },
        sCtx
      )
      expect(mockedDesktop.drag).toHaveBeenCalledWith(
        { x: 20, y: 20 },
        { x: 100, y: 100 },
        { button: "left" },
        sCtx
      )
      await dispatchAnthropicAction(
        { action: "scroll", coordinate: [50, 50], scroll_direction: "down", scroll_amount: 1 },
        sCtx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 100, y: 100 },
        { dy: 120 },
        sCtx
      )
    })
  })

  describe("branch coverage extras", () => {
    it("scroll left/right map to dx deltas", async () => {
      mockedDesktop.scroll.mockResolvedValue(undefined)
      await dispatchAnthropicAction(
        { action: "scroll", coordinate: [1, 1], scroll_direction: "left", scroll_amount: 2 },
        ctx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 1, y: 1 },
        { dx: -240 },
        ctx
      )
      await dispatchAnthropicAction(
        { action: "scroll", coordinate: [1, 1], scroll_direction: "right", scroll_amount: 2 },
        ctx
      )
      expect(mockedDesktop.scroll).toHaveBeenCalledWith(
        { kind: "point", x: 1, y: 1 },
        { dx: 240 },
        ctx
      )
    })

    it("dedup stays on when settingsGet rejects (web stub fallback)", async () => {
      mockedDesktop.settingsGet.mockRejectedValue(new Error("UNSUPPORTED_PLATFORM"))
      mockedDesktop.screenshot.mockResolvedValue(shot("SAME", 10, 10))
      const sCtx = { ...ctx, sessionKey: "fallback-1" }
      await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      const second = await dispatchAnthropicAction({ action: "screenshot" }, sCtx)
      expect(second.output).toContain("unchanged")
    })

    it("hold_key and wait tolerate missing durations", async () => {
      mockedDesktop.holdKey.mockResolvedValueOnce(undefined)
      await dispatchAnthropicAction(
        { action: "hold_key", text: "Shift", duration: undefined as unknown as number },
        ctx
      )
      expect(mockedDesktop.holdKey).toHaveBeenCalledWith(["Shift"], 0, ctx)
      const r = await dispatchAnthropicAction(
        { action: "wait", duration: undefined as unknown as number },
        ctx
      )
      expect(r.ok).toBe(true)
    })

    it("serializes structured throw values into the error envelope", async () => {
      mockedDesktop.type.mockRejectedValueOnce({ code: "GATE_DENIED" })
      const result = await dispatchAnthropicAction({ action: "type", text: "x" }, ctx)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("GATE_DENIED")
    })

    it("falls back to String() for non-serializable throw values", async () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      mockedDesktop.type.mockRejectedValueOnce(circular)
      const result = await dispatchAnthropicAction({ action: "type", text: "x" }, ctx)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("object")
    })

    it("unknown action variants return a typed error", async () => {
      const result = await dispatchAnthropicAction(
        { action: "bogus" } as unknown as Parameters<typeof dispatchAnthropicAction>[0],
        ctx
      )
      expect(result).toEqual({ ok: false, error: "unknown action" })
    })
  })

  describe("loop guards", () => {
    it("caps wait at 30s and reports the clamp", async () => {
      jest.useFakeTimers()
      try {
        const promise = dispatchAnthropicAction({ action: "wait", duration: 120 }, ctx)
        jest.advanceTimersByTime(30_000)
        const result = await promise
        expect(result.ok).toBe(true)
        expect(result.output).toContain("capped")
      } finally {
        jest.useRealTimers()
      }
    })

    it("appends guidance after 5 consecutive failures", async () => {
      mockedDesktop.click.mockRejectedValue(new Error("boom"))
      const sCtx = { ...ctx, sessionKey: "fail-1" }
      let last: Awaited<ReturnType<typeof dispatchAnthropicAction>> | undefined
      for (let i = 0; i < 5; i++) {
        last = await dispatchAnthropicAction({ action: "left_click", coordinate: [1, 1] }, sCtx)
      }
      expect(last?.ok).toBe(false)
      expect(last?.error).toContain("consecutive")
      // A success resets the streak — next failure has no guidance.
      mockedDesktop.click.mockResolvedValueOnce(undefined)
      await dispatchAnthropicAction({ action: "left_click", coordinate: [1, 1] }, sCtx)
      mockedDesktop.click.mockRejectedValueOnce(new Error("boom"))
      const afterReset = await dispatchAnthropicAction(
        { action: "left_click", coordinate: [1, 1] },
        sCtx
      )
      expect(afterReset.error).toBe("boom")
    })
  })
})
