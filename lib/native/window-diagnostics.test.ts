/**
 * @jest-environment jsdom
 *
 * Tests for native/window-diagnostics.getWindowDiagnostics()
 */

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const isVisibleMock = jest.fn()
const isMinimizedMock = jest.fn()
const isMaximizedMock = jest.fn()
const isFocusedMock = jest.fn()
const outerPositionMock = jest.fn()
const outerSizeMock = jest.fn()
const getCurrentWindowMock = jest.fn()

jest.mock(
  "@tauri-apps/api/window",
  () => ({
    getCurrentWindow: () => getCurrentWindowMock(),
  }),
  { virtual: true }
)

const getAllWebviewsMock = jest.fn()
jest.mock(
  "@tauri-apps/api/webview",
  () => ({
    getAllWebviews: () => getAllWebviewsMock(),
  }),
  { virtual: true }
)

import { getWindowDiagnostics } from "./window-diagnostics"

beforeEach(() => {
  isTauriValue = false
  isVisibleMock.mockReset()
  isMinimizedMock.mockReset()
  isMaximizedMock.mockReset()
  isFocusedMock.mockReset()
  outerPositionMock.mockReset()
  outerSizeMock.mockReset()
  getCurrentWindowMock.mockReset()
  getAllWebviewsMock.mockReset()

  getCurrentWindowMock.mockReturnValue({
    label: "main",
    isVisible: () => isVisibleMock(),
    isMinimized: () => isMinimizedMock(),
    isMaximized: () => isMaximizedMock(),
    isFocused: () => isFocusedMock(),
    outerPosition: () => outerPositionMock(),
    outerSize: () => outerSizeMock(),
  })
})

describe("getWindowDiagnostics", () => {
  it("returns null on web", async () => {
    isTauriValue = false
    expect(await getWindowDiagnostics()).toBeNull()
  })

  it("returns a fully populated snapshot in Tauri mode", async () => {
    isTauriValue = true
    isVisibleMock.mockResolvedValue(true)
    isMinimizedMock.mockResolvedValue(false)
    isMaximizedMock.mockResolvedValue(true)
    isFocusedMock.mockResolvedValue(true)
    outerPositionMock.mockResolvedValue({ x: 12, y: 34 })
    outerSizeMock.mockResolvedValue({ width: 1280, height: 720 })
    getAllWebviewsMock.mockResolvedValue([{}, {}, {}])

    const snap = await getWindowDiagnostics()
    expect(snap).toBeTruthy()
    expect(snap?.totalWindows).toBe(3)
    expect(snap?.mainWindow).toEqual({
      label: "main",
      isVisible: true,
      isMinimized: false,
      isMaximized: true,
      isFocused: true,
      position: [12, 34],
      size: [1280, 720],
    })
    expect(typeof snap?.timestamp).toBe("number")
  })

  it("falls back to per-method false/null on read failures", async () => {
    isTauriValue = true
    isVisibleMock.mockRejectedValue(new Error("boom"))
    isMinimizedMock.mockRejectedValue(new Error("boom"))
    isMaximizedMock.mockRejectedValue(new Error("boom"))
    isFocusedMock.mockRejectedValue(new Error("boom"))
    outerPositionMock.mockRejectedValue(new Error("boom"))
    outerSizeMock.mockRejectedValue(new Error("boom"))
    getAllWebviewsMock.mockResolvedValue([])

    const snap = await getWindowDiagnostics()
    expect(snap?.mainWindow).toEqual({
      label: "main",
      isVisible: false,
      isMinimized: false,
      isMaximized: false,
      isFocused: false,
      position: null,
      size: null,
    })
    expect(snap?.totalWindows).toBe(0)
  })

  it("returns null mainWindow when getCurrentWindow throws", async () => {
    isTauriValue = true
    getCurrentWindowMock.mockImplementationOnce(() => {
      throw new Error("no window")
    })
    getAllWebviewsMock.mockResolvedValue([{}])

    const snap = await getWindowDiagnostics()
    expect(snap?.mainWindow).toBeNull()
    expect(snap?.totalWindows).toBe(1)
  })

  it("estimates total when getAllWebviews throws and a main window exists", async () => {
    isTauriValue = true
    isVisibleMock.mockResolvedValue(true)
    isMinimizedMock.mockResolvedValue(false)
    isMaximizedMock.mockResolvedValue(false)
    isFocusedMock.mockResolvedValue(true)
    outerPositionMock.mockResolvedValue({ x: 0, y: 0 })
    outerSizeMock.mockResolvedValue({ width: 100, height: 100 })
    getAllWebviewsMock.mockRejectedValue(new Error("webview error"))

    const snap = await getWindowDiagnostics()
    expect(snap?.totalWindows).toBe(1)
  })

  it("reports 0 total windows when both webview enumeration and main window fail", async () => {
    isTauriValue = true
    getCurrentWindowMock.mockImplementationOnce(() => {
      throw new Error("no window")
    })
    getAllWebviewsMock.mockRejectedValue(new Error("webview error"))

    const snap = await getWindowDiagnostics()
    expect(snap?.mainWindow).toBeNull()
    expect(snap?.totalWindows).toBe(0)
  })
})
