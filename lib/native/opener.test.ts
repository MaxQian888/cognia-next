jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock(
  "@tauri-apps/plugin-opener",
  () => ({
    openUrl: jest.fn(),
    openPath: jest.fn(),
  }),
  { virtual: true }
)

import { isTauri } from "@/lib/tauri"
import { openPath, openUrl } from "./opener"
import { openUrl as pluginOpenUrl, openPath as pluginOpenPath } from "@tauri-apps/plugin-opener"

const mockIsTauri = jest.mocked(isTauri)

beforeEach(() => {
  jest.mocked(pluginOpenUrl).mockReset().mockResolvedValue(undefined)
  jest.mocked(pluginOpenPath).mockReset().mockResolvedValue(undefined)
  mockIsTauri.mockReset()
})

describe("openUrl", () => {
  test("delegates to @tauri-apps/plugin-opener when running in Tauri", async () => {
    mockIsTauri.mockReturnValue(true)
    await openUrl("https://example.com")
    expect(pluginOpenUrl).toHaveBeenCalledWith("https://example.com")
  })

  test("falls through to window.open when the Tauri plugin throws", async () => {
    mockIsTauri.mockReturnValue(true)
    jest.mocked(pluginOpenUrl).mockRejectedValueOnce(new Error("plugin missing"))
    const open = jest.spyOn(window, "open").mockReturnValue(null)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    await openUrl("https://example.com")

    expect(pluginOpenUrl).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("openUrl: tauri opener failed"),
      expect.any(Error)
    )

    open.mockRestore()
    warn.mockRestore()
  })

  test("forceWebFallback skips Tauri even when isTauri() is true", async () => {
    mockIsTauri.mockReturnValue(true)
    const open = jest.spyOn(window, "open").mockReturnValue(null)

    await openUrl("https://example.com", { forceWebFallback: true })

    expect(pluginOpenUrl).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")

    open.mockRestore()
  })

  test("uses window.open in web mode (isTauri() = false)", async () => {
    mockIsTauri.mockReturnValue(false)
    const open = jest.spyOn(window, "open").mockReturnValue(null)

    await openUrl("https://example.com")

    expect(pluginOpenUrl).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")

    open.mockRestore()
  })
})

describe("openPath", () => {
  test("delegates to @tauri-apps/plugin-opener.openPath when in Tauri", async () => {
    mockIsTauri.mockReturnValue(true)
    await openPath("/var/log/app.log")
    expect(pluginOpenPath).toHaveBeenCalledWith("/var/log/app.log")
  })

  test("falls back to window.open when the Tauri plugin rejects", async () => {
    mockIsTauri.mockReturnValue(true)
    jest.mocked(pluginOpenPath).mockRejectedValueOnce(new Error("nope"))
    const open = jest.spyOn(window, "open").mockReturnValue(null)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    await openPath("/var/log/app.log")

    expect(open).toHaveBeenCalledWith("/var/log/app.log", "_blank", "noopener,noreferrer")
    expect(warn).toHaveBeenCalled()

    open.mockRestore()
    warn.mockRestore()
  })

  test("uses window.open with relative-path semantics in web mode", async () => {
    mockIsTauri.mockReturnValue(false)
    const open = jest.spyOn(window, "open").mockReturnValue(null)

    await openPath("downloads/report.pdf")

    expect(pluginOpenPath).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("downloads/report.pdf", "_blank", "noopener,noreferrer")

    open.mockRestore()
  })

  test("forceWebFallback skips Tauri even when isTauri() is true", async () => {
    mockIsTauri.mockReturnValue(true)
    const open = jest.spyOn(window, "open").mockReturnValue(null)

    await openPath("/some/file", { forceWebFallback: true })

    expect(pluginOpenPath).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("/some/file", "_blank", "noopener,noreferrer")

    open.mockRestore()
  })
})
