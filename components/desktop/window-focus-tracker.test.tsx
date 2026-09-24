/**
 * @jest-environment jsdom
 */
import { render, waitFor, act } from "@testing-library/react"

const logWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      warn: (...args: unknown[]) => logWarn(...args),
      info: jest.fn(),
      error: jest.fn(),
    },
  },
}))

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const isFocused = jest.fn().mockResolvedValue(true)
const onFocusChanged = jest.fn().mockImplementation(async () => () => {})
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused, onFocusChanged }),
}))

import { WindowFocusTracker } from "./window-focus-tracker"

beforeEach(() => {
  logWarn.mockReset()
  isTauriMock.mockReset()
  isFocused.mockReset().mockResolvedValue(true)
  onFocusChanged.mockReset().mockImplementation(async () => () => {})
  document.documentElement.removeAttribute("data-window-focused")
})

test("web mode marks the window as focused", () => {
  isTauriMock.mockReturnValue(false)
  render(<WindowFocusTracker />)
  expect(document.documentElement.getAttribute("data-window-focused")).toBe("true")
})

test("Tauri mode seeds focus state from isFocused()", async () => {
  isTauriMock.mockReturnValue(true)
  isFocused.mockResolvedValue(false)
  render(<WindowFocusTracker />)
  await waitFor(() =>
    expect(document.documentElement.getAttribute("data-window-focused")).toBe("false")
  )
})

test("subscribes to onFocusChanged and updates the attribute", async () => {
  isTauriMock.mockReturnValue(true)
  isFocused.mockResolvedValue(true)
  let cb: ((p: { payload: boolean }) => void) | undefined
  onFocusChanged.mockImplementation(async (handler: (p: { payload: boolean }) => void) => {
    cb = handler
    return () => {}
  })
  render(<WindowFocusTracker />)
  await waitFor(() =>
    expect(document.documentElement.getAttribute("data-window-focused")).toBe("true")
  )
  await act(async () => {
    cb?.({ payload: false })
  })
  expect(document.documentElement.getAttribute("data-window-focused")).toBe("false")
  await act(async () => {
    cb?.({ payload: true })
  })
  expect(document.documentElement.getAttribute("data-window-focused")).toBe("true")
})

test("logs a warning when setup throws", async () => {
  isTauriMock.mockReturnValue(true)
  isFocused.mockRejectedValueOnce(new Error("nope"))
  render(<WindowFocusTracker />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "focus-tracker setup failed",
      expect.objectContaining({ error: "nope" })
    )
  )
})

test("setup-failed warning falls back to String(err) for non-Error throws", async () => {
  isTauriMock.mockReturnValue(true)
  isFocused.mockRejectedValueOnce("string-err")
  render(<WindowFocusTracker />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "focus-tracker setup failed",
      expect.objectContaining({ error: "string-err" })
    )
  )
})

test("calls the unlisten function on unmount", async () => {
  isTauriMock.mockReturnValue(true)
  const unlisten = jest.fn()
  onFocusChanged.mockResolvedValue(unlisten)
  const { unmount } = render(<WindowFocusTracker />)
  await waitFor(() => expect(onFocusChanged).toHaveBeenCalled())
  unmount()
  await waitFor(() => expect(unlisten).toHaveBeenCalled())
})

test("a rejecting Tauri disposer never surfaces as an unhandled rejection", async () => {
  isTauriMock.mockReturnValue(true)
  const unlisten = jest
    .fn()
    .mockRejectedValue(
      new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')")
    )
  onFocusChanged.mockResolvedValue(unlisten)
  const unhandled = jest.fn()
  process.on("unhandledRejection", unhandled)
  try {
    const { unmount } = render(<WindowFocusTracker />)
    await waitFor(() => expect(onFocusChanged).toHaveBeenCalled())
    await act(async () => {})
    expect(() => unmount()).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off("unhandledRejection", unhandled)
  }
})

test("releases a listener whose registration resolves after unmount", async () => {
  isTauriMock.mockReturnValue(true)
  const unlisten = jest.fn()
  let resolveRegistration: ((fn: () => void) => void) | undefined
  onFocusChanged.mockImplementation(
    () =>
      new Promise<() => void>((resolve) => {
        resolveRegistration = resolve
      })
  )
  const { unmount } = render(<WindowFocusTracker />)
  await waitFor(() => expect(onFocusChanged).toHaveBeenCalled())
  unmount()
  expect(unlisten).not.toHaveBeenCalled()
  await act(async () => {
    resolveRegistration?.(unlisten)
  })
  expect(unlisten).toHaveBeenCalledTimes(1)
})
