/**
 * @jest-environment jsdom
 */
import { impact, notify, selection, selectionFeedback, vibrate } from "./haptics"

function makeMockHaptics() {
  return {
    impact: jest.fn().mockResolvedValue(undefined),
    notification: jest.fn().mockResolvedValue(undefined),
    vibrate: jest.fn().mockResolvedValue(undefined),
    selectionStart: jest.fn().mockResolvedValue(undefined),
    selectionChanged: jest.fn().mockResolvedValue(undefined),
    selectionEnd: jest.fn().mockResolvedValue(undefined),
  }
}

describe("haptics wrapper", () => {
  it("impact maps styles and returns ok", async () => {
    const mock = makeMockHaptics()
    const out = await impact("heavy", async () => mock)
    expect(mock.impact).toHaveBeenCalledWith({ style: "HEAVY" })
    expect(out).toEqual({ kind: "ok" })
  })

  it("impact defaults to light", async () => {
    const mock = makeMockHaptics()
    await impact(undefined, async () => mock)
    expect(mock.impact).toHaveBeenCalledWith({ style: "LIGHT" })
  })

  it("notify maps types", async () => {
    const mock = makeMockHaptics()
    await notify("error", async () => mock)
    expect(mock.notification).toHaveBeenCalledWith({ type: "ERROR" })
  })

  it("vibrate forwards duration", async () => {
    const mock = makeMockHaptics()
    await vibrate(500, async () => mock)
    expect(mock.vibrate).toHaveBeenCalledWith({ duration: 500 })
  })

  it("selection dispatches by phase", async () => {
    const mock = makeMockHaptics()
    await selection("start", async () => mock)
    await selection("changed", async () => mock)
    await selection("end", async () => mock)
    expect(mock.selectionStart).toHaveBeenCalled()
    expect(mock.selectionChanged).toHaveBeenCalled()
    expect(mock.selectionEnd).toHaveBeenCalled()
  })

  it("selectionFeedback fires selectionChanged", async () => {
    const mock = makeMockHaptics()
    await selectionFeedback(async () => mock)
    expect(mock.selectionChanged).toHaveBeenCalled()
  })

  it("returns unsupported when loader rejects", async () => {
    const out = await impact("light", async () => {
      throw new Error("not on web")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when action throws", async () => {
    const mock = makeMockHaptics()
    mock.impact.mockRejectedValue(new Error("device busy"))
    const out = await impact("light", async () => mock)
    expect(out).toEqual({ kind: "error", message: "device busy" })
  })
})
