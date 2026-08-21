/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

const logInfo = jest.fn()
const logWarn = jest.fn()
const logError = jest.fn()
// Indirected through arrows: `child()` runs at import time, when the consts
// above are still in their temporal dead zone.
jest.mock("@cognia/logging", () => ({
  loggers: {
    shell: {
      child: () => ({
        info: (...args: unknown[]) => logInfo(...args),
        warn: (...args: unknown[]) => logWarn(...args),
        error: (...args: unknown[]) => logError(...args),
      }),
    },
  },
}))

const minimize = jest.fn().mockResolvedValue(undefined)
const toggleMaximize = jest.fn().mockResolvedValue(undefined)
const close = jest.fn().mockResolvedValue(undefined)
const isMaximized = jest.fn().mockResolvedValue(false)
const onResized = jest.fn().mockResolvedValue(() => {})
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize, toggleMaximize, close, isMaximized, onResized }),
}))

import { WindowControls, useWindowChromeMode } from "./window-controls"

function setPlatform(platform: "Win32" | "MacIntel") {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true })
}

/** Probe component — the hook is the contract full-window surfaces read. */
function Mode() {
  return <span data-testid="mode">{useWindowChromeMode()}</span>
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(false)
  isMaximized.mockResolvedValue(false)
})

describe("useWindowChromeMode", () => {
  it("reports no window chrome in the web shell", async () => {
    isTauriMock.mockReturnValue(false)
    setPlatform("Win32")
    render(<Mode />)
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("none"))
  })

  it("reports traffic lights on macOS so surfaces reserve room instead of drawing buttons", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("MacIntel")
    render(<Mode />)
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("traffic-lights"))
  })

  it("reports buttons on Windows/Linux, where the app draws the only controls there are", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    render(<Mode />)
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent("buttons"))
  })
})

describe("WindowControls", () => {
  it("renders nothing outside Tauri, so callers can mount it unconditionally", async () => {
    isTauriMock.mockReturnValue(false)
    setPlatform("Win32")
    render(<WindowControls />)
    await waitFor(() => expect(screen.queryByTestId("window-controls")).toBeNull())
  })

  it("renders nothing on macOS — the native traffic lights are already there", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("MacIntel")
    render(<WindowControls />)
    await waitFor(() => expect(screen.queryByTestId("window-controls")).toBeNull())
  })

  it("routes minimize / maximize / close to the Tauri window API", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    const user = userEvent.setup()
    render(<WindowControls />)
    await waitFor(() => expect(screen.getByLabelText("minimize")).toBeInTheDocument())

    await user.click(screen.getByLabelText("minimize"))
    await waitFor(() => expect(minimize).toHaveBeenCalled())
    expect(logInfo).toHaveBeenCalledWith("window minimize")

    await user.click(screen.getByLabelText("maximize"))
    await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())

    await user.click(screen.getByLabelText("close"))
    await waitFor(() => expect(close).toHaveBeenCalled())
  })

  it("labels the maximize button Restore once the window is maximized", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    isMaximized.mockResolvedValue(true)
    render(<WindowControls />)
    await waitFor(() => expect(screen.getByLabelText("restore")).toBeInTheDocument())
  })

  it("survives a window API that throws instead of leaving the surface uncloseable", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    isMaximized.mockRejectedValueOnce(new Error("no window"))
    render(<WindowControls />)
    await waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith("window setup failed", expect.any(Object))
    )
    // Still rendered: the buttons are the only way to close a frameless window.
    expect(screen.getByLabelText("close")).toBeInTheDocument()
  })

  it("keeps the buttons square — a radius would let the page show through the window corner", async () => {
    isTauriMock.mockReturnValue(true)
    setPlatform("Win32")
    render(<WindowControls />)
    await waitFor(() => expect(screen.getByLabelText("close")).toHaveClass("rounded-none"))
  })
})
