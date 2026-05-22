/**
 * @jest-environment jsdom
 */
import { hide, setBackgroundColor, setOverlay, setStyle, show, syncWithTheme } from "./status-bar"

function makeSb() {
  return {
    setStyle: jest.fn().mockResolvedValue(undefined),
    setBackgroundColor: jest.fn().mockResolvedValue(undefined),
    show: jest.fn().mockResolvedValue(undefined),
    hide: jest.fn().mockResolvedValue(undefined),
    setOverlaysWebView: jest.fn().mockResolvedValue(undefined),
  }
}

describe("status-bar", () => {
  it("setStyle maps lowercase to plugin enum", async () => {
    const sb = makeSb()
    await setStyle("light", async () => sb)
    expect(sb.setStyle).toHaveBeenCalledWith({ style: "LIGHT" })
  })

  it("setBackgroundColor passes color through", async () => {
    const sb = makeSb()
    await setBackgroundColor("#ff0000", async () => sb)
    expect(sb.setBackgroundColor).toHaveBeenCalledWith({ color: "#ff0000" })
  })

  it("show / hide call the right method", async () => {
    const sb = makeSb()
    await show(async () => sb)
    await hide(async () => sb)
    expect(sb.show).toHaveBeenCalled()
    expect(sb.hide).toHaveBeenCalled()
  })

  it("setOverlay forwards overlay flag", async () => {
    const sb = makeSb()
    await setOverlay(true, async () => sb)
    expect(sb.setOverlaysWebView).toHaveBeenCalledWith({ overlay: true })
  })

  it("syncWithTheme picks LIGHT bar for dark theme", async () => {
    const sb = makeSb()
    await syncWithTheme("dark", undefined, async () => sb)
    expect(sb.setStyle).toHaveBeenCalledWith({ style: "LIGHT" })
  })

  it("syncWithTheme picks DARK bar for light theme", async () => {
    const sb = makeSb()
    await syncWithTheme("light", undefined, async () => sb)
    expect(sb.setStyle).toHaveBeenCalledWith({ style: "DARK" })
  })

  it("syncWithTheme also pushes a token-derived backgroundHex when provided", async () => {
    const sb = makeSb()
    await syncWithTheme("dark", "#101820", async () => sb)
    expect(sb.setStyle).toHaveBeenCalledWith({ style: "LIGHT" })
    expect(sb.setBackgroundColor).toHaveBeenCalledWith({ color: "#101820" })
  })

  it("syncWithTheme leaves the background colour alone when no backgroundHex is passed", async () => {
    const sb = makeSb()
    await syncWithTheme("light", undefined, async () => sb)
    expect(sb.setBackgroundColor).not.toHaveBeenCalled()
  })

  it("returns unsupported when plugin not loadable", async () => {
    const out = await setStyle("light", async () => {
      throw new Error("nope")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})
