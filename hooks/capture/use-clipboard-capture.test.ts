import { renderHook, waitFor } from "@testing-library/react"

jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))
jest.mock("@/lib/native/utils", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/capture/enrich", () => ({ buildEnrichDeps: jest.fn(() => ({})) }))

const mockRequest = jest.fn()
jest.mock("@/stores/capture/capture-store", () => ({
  useCaptureStore: { getState: () => ({ request: mockRequest }) },
}))
jest.mock("@/lib/capture/capture-manager", () => ({
  persistCapture: jest.fn(async () => null),
  detectSourceApp: jest.fn(async () => undefined),
}))

import { useSettingsStore } from "@/stores/settings"
import { persistCapture } from "@/lib/capture/capture-manager"
import { useClipboardCapture } from "./use-clipboard-capture"

const mockSettings = useSettingsStore as unknown as jest.Mock
const request = mockRequest
const mockPersist = persistCapture as jest.Mock

function setCapture(cfg: unknown) {
  mockSettings.mockImplementation((sel: (s: unknown) => unknown) =>
    sel({ settings: { capture: cfg } })
  )
}

function setClipboard(text: string) {
  Object.defineProperty(global.navigator, "clipboard", {
    configurable: true,
    value: { readText: jest.fn(async () => text) },
  })
}

beforeEach(() => jest.clearAllMocks())

describe("useClipboardCapture", () => {
  it("does nothing when disabled", async () => {
    setCapture({ enabled: false, mode: "confirm", pollIntervalMs: 20, privacyMode: false })
    setClipboard("hello")
    const { unmount } = renderHook(() => useClipboardCapture())
    await new Promise((r) => setTimeout(r, 80))
    expect(request).not.toHaveBeenCalled()
    unmount()
  })

  it("requests a confirm bubble for new clipboard text", async () => {
    setCapture({
      enabled: true,
      mode: "confirm",
      pollIntervalMs: 20,
      confirmTimeoutSec: 8,
      privacyMode: false,
    })
    setClipboard("a fresh clipboard note")
    const { unmount } = renderHook(() => useClipboardCapture())
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "text", text: "a fresh clipboard note" })
      )
    )
    unmount()
  })

  it("auto-saves in silent mode", async () => {
    setCapture({
      enabled: true,
      mode: "silent",
      pollIntervalMs: 20,
      confirmTimeoutSec: 8,
      privacyMode: false,
    })
    setClipboard("https://x.test/page")
    const { unmount } = renderHook(() => useClipboardCapture())
    await waitFor(() => expect(mockPersist).toHaveBeenCalled())
    expect(request).not.toHaveBeenCalled()
    unmount()
  })
})
