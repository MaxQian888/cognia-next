/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const logInfo = jest.fn()
const logWarn = jest.fn()
const logError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: (...args: unknown[]) => logError(...args),
    },
  },
}))

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const minimize = jest.fn().mockResolvedValue(undefined)
const toggleMaximize = jest.fn().mockResolvedValue(undefined)
const close = jest.fn().mockResolvedValue(undefined)
const isMaximized = jest.fn().mockResolvedValue(false)
const onResized = jest.fn().mockResolvedValue(() => {})

jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize,
    toggleMaximize,
    close,
    isMaximized,
    onResized,
  }),
}))

import { TitleBar } from "./title-bar"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  logError.mockReset()
  minimize.mockClear()
  toggleMaximize.mockClear()
  close.mockClear()
  isMaximized.mockClear().mockResolvedValue(false)
  onResized.mockClear().mockResolvedValue(() => {})
})

test("renders nothing when not in Tauri", () => {
  isTauriMock.mockReturnValue(false)
  const { container } = render(<TitleBar />)
  expect(container.firstChild).toBeNull()
})

test("renders the brand text in Tauri", async () => {
  isTauriMock.mockReturnValue(true)
  // navigator.platform isn't "Mac" so buttons render
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true })
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByText("Cognia")).toBeInTheDocument())
})

test("clicking minimize/maximize/close routes to the Tauri window API and logs", async () => {
  isTauriMock.mockReturnValue(true)
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true })
  const user = userEvent.setup()
  render(<TitleBar />)
  await waitFor(() => expect(screen.getByLabelText("minimize")).toBeInTheDocument())
  await user.click(screen.getByLabelText("minimize"))
  await waitFor(() => expect(minimize).toHaveBeenCalled())
  expect(logInfo).toHaveBeenCalledWith("title-bar minimize")

  await user.click(screen.getByLabelText("maximize"))
  await waitFor(() => expect(toggleMaximize).toHaveBeenCalled())

  await user.click(screen.getByLabelText("close"))
  await waitFor(() => expect(close).toHaveBeenCalled())
})

test("hides window controls on Mac (traffic lights are native)", async () => {
  isTauriMock.mockReturnValue(true)
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
  render(<TitleBar />)
  // Wait for the async platform detection to flip the layout to Mac mode.
  await waitFor(() => expect(screen.queryByLabelText("minimize")).toBeNull())
  expect(screen.queryByLabelText("close")).toBeNull()
})

test("logs a structured warning when Tauri window setup fails", async () => {
  isTauriMock.mockReturnValue(true)
  Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true })
  isMaximized.mockRejectedValueOnce(new Error("boom"))
  render(<TitleBar />)
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "title-bar window setup failed",
      expect.objectContaining({ error: "boom" })
    )
  )
})
