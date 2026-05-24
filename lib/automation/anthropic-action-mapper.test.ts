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
import { dispatchAnthropicAction } from "./anthropic-action-mapper"

const mockedDesktop = desktop as jest.Mocked<typeof desktop>
const ctx = { surface: "computerUse" as const }

afterEach(() => {
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
})
