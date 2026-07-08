/** @jest-environment jsdom */
import { openExternal, openPath, revealInExplorer } from "./opener"

jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: jest.fn(),
  openPath: jest.fn(),
  revealItemInDir: jest.fn(),
}))

import {
  openUrl as openUrlNative,
  openPath as openPathNative,
  revealItemInDir as revealNative,
} from "@tauri-apps/plugin-opener"

const mockedOpenUrl = openUrlNative as jest.MockedFunction<typeof openUrlNative>
const mockedOpenPath = openPathNative as jest.MockedFunction<typeof openPathNative>
const mockedReveal = revealNative as jest.MockedFunction<typeof revealNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/opener", () => {
  let originalOpen: typeof window.open
  let openSpy: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    originalOpen = window.open
    openSpy = jest.fn()
    window.open = openSpy as unknown as typeof window.open
  })

  afterEach(() => {
    setTauri(false)
    window.open = originalOpen
  })

  describe("openExternal", () => {
    it("uses native openUrl when in Tauri", async () => {
      setTauri(true)
      mockedOpenUrl.mockResolvedValue(undefined)
      await openExternal("https://example.com")
      expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com")
      expect(openSpy).not.toHaveBeenCalled()
    })

    it("falls back to window.open in browser", async () => {
      await openExternal("https://example.com")
      expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
      expect(mockedOpenUrl).not.toHaveBeenCalled()
    })
  })

  describe("openPath", () => {
    it("is a no-op outside Tauri", async () => {
      await openPath("/x/y.md")
      expect(mockedOpenPath).not.toHaveBeenCalled()
    })

    it("calls native openPath in Tauri", async () => {
      setTauri(true)
      mockedOpenPath.mockResolvedValue(undefined)
      await openPath("/x/y.md")
      expect(mockedOpenPath).toHaveBeenCalledWith("/x/y.md")
    })
  })

  describe("revealInExplorer", () => {
    it("is a no-op outside Tauri", async () => {
      await revealInExplorer("/x/y")
      expect(mockedReveal).not.toHaveBeenCalled()
    })

    it("calls native revealItemInDir in Tauri", async () => {
      setTauri(true)
      mockedReveal.mockResolvedValue(undefined)
      await revealInExplorer("/x/y")
      expect(mockedReveal).toHaveBeenCalledWith("/x/y")
    })
  })
})
