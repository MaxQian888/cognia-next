/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"

const logWarn = jest.fn()
const logError = jest.fn()

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      warn: (...args: unknown[]) => logWarn(...args),
      error: (...args: unknown[]) => logError(...args),
      info: jest.fn(),
    },
  },
}))

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const startResizeDragging = jest.fn().mockResolvedValue(undefined)
const isMaximized = jest.fn().mockResolvedValue(false)
const isFullscreen = jest.fn().mockResolvedValue(false)
const onResized = jest.fn().mockImplementation(async () => () => {})

jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startResizeDragging,
    isMaximized,
    isFullscreen,
    onResized,
  }),
}))

import { WindowResizeEdges } from "./window-resize-edges"

beforeEach(() => {
  logWarn.mockReset()
  logError.mockReset()
  isTauriMock.mockReset()
  startResizeDragging.mockReset().mockResolvedValue(undefined)
  isMaximized.mockReset().mockResolvedValue(false)
  isFullscreen.mockReset().mockResolvedValue(false)
  onResized.mockReset().mockImplementation(async () => () => {})
})

test("renders nothing in web mode", () => {
  isTauriMock.mockReturnValue(false)
  const { container } = render(<WindowResizeEdges />)
  expect(container.firstChild).toBeNull()
})

test("renders 8 handles when window is windowed", async () => {
  isTauriMock.mockReturnValue(true)
  render(<WindowResizeEdges />)
  await waitFor(() => expect(screen.getByTestId("window-resize-edges")).toBeInTheDocument())
  for (const id of [
    "resize-north",
    "resize-south",
    "resize-west",
    "resize-east",
    "resize-nw",
    "resize-ne",
    "resize-sw",
    "resize-se",
  ]) {
    expect(screen.getByTestId(id)).toBeInTheDocument()
  }
})

test("hides handles when window is maximized", async () => {
  isTauriMock.mockReturnValue(true)
  isMaximized.mockResolvedValue(true)
  const { container } = render(<WindowResizeEdges />)
  await waitFor(() => {
    expect(container.firstChild).toBeNull()
  })
})

test("hides handles when window is fullscreen", async () => {
  isTauriMock.mockReturnValue(true)
  isFullscreen.mockResolvedValue(true)
  const { container } = render(<WindowResizeEdges />)
  await waitFor(() => {
    expect(container.firstChild).toBeNull()
  })
})

test.each([
  ["resize-north", "North"],
  ["resize-south", "South"],
  ["resize-west", "West"],
  ["resize-east", "East"],
  ["resize-nw", "NorthWest"],
  ["resize-ne", "NorthEast"],
  ["resize-sw", "SouthWest"],
  ["resize-se", "SouthEast"],
])("mousedown on %s calls startResizeDragging(%s)", async (testId, direction) => {
  isTauriMock.mockReturnValue(true)
  render(<WindowResizeEdges />)
  await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument())
  const target = screen.getByTestId(testId)
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })
  await waitFor(() => expect(startResizeDragging).toHaveBeenCalledWith(direction))
})

test("ignores non-primary mouse buttons", async () => {
  isTauriMock.mockReturnValue(true)
  render(<WindowResizeEdges />)
  await waitFor(() => expect(screen.getByTestId("resize-north")).toBeInTheDocument())
  await act(async () => {
    screen
      .getByTestId("resize-north")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }))
  })
  expect(startResizeDragging).not.toHaveBeenCalled()
})

test("logs an error when startResizeDragging rejects", async () => {
  isTauriMock.mockReturnValue(true)
  startResizeDragging.mockRejectedValueOnce(new Error("denied"))
  render(<WindowResizeEdges />)
  await waitFor(() => expect(screen.getByTestId("resize-east")).toBeInTheDocument())
  await act(async () => {
    screen
      .getByTestId("resize-east")
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
  })
  await waitFor(() =>
    expect(logError).toHaveBeenCalledWith(
      "resize-edges startResizeDragging failed",
      expect.any(Error)
    )
  )
})

test("logs a warning when window setup throws", async () => {
  isTauriMock.mockReturnValue(true)
  isMaximized.mockRejectedValueOnce(new Error("boom"))
  render(<WindowResizeEdges />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "resize-edges setup failed",
      expect.objectContaining({ error: "boom" })
    )
  )
})

test("setup-failed warning falls back to String(err) when a non-Error is thrown", async () => {
  isTauriMock.mockReturnValue(true)
  isMaximized.mockRejectedValueOnce("plain")
  render(<WindowResizeEdges />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "resize-edges setup failed",
      expect.objectContaining({ error: "plain" })
    )
  )
})

test("re-evaluates active state when onResized fires", async () => {
  isTauriMock.mockReturnValue(true)
  let resizedCb: (() => void) | undefined
  onResized.mockImplementation(async (cb: () => void) => {
    resizedCb = cb
    return () => {}
  })
  render(<WindowResizeEdges />)
  await waitFor(() => expect(screen.getByTestId("window-resize-edges")).toBeInTheDocument())
  // Now flip to maximized and trigger the listener.
  isMaximized.mockResolvedValue(true)
  await act(async () => {
    resizedCb?.()
  })
  await waitFor(() => expect(screen.queryByTestId("window-resize-edges")).toBeNull())
})
