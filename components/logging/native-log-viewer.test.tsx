/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/logging/use-native-log-query", () => ({
  useNativeLogQuery: jest.fn(),
}))

import { useNativeLogQuery } from "@/hooks/logging/use-native-log-query"
import { NativeLogViewer } from "./native-log-viewer"

const useNativeLogQueryMock = useNativeLogQuery as jest.Mock

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    query: { file: "structured", limit: 200 },
    setQuery: jest.fn(),
    result: {
      entries: [
        {
          timestamp: "2026-07-11T01:00:00Z",
          epochMs: 1783991000000,
          level: "warn",
          target: "network::lark",
          message: "slow response",
        },
        {
          timestamp: "2026-07-11T01:00:01Z",
          epochMs: 1783991001000,
          level: "error",
          target: "connectors",
          message: "send failed",
        },
      ],
      fileSize: 2048,
      scannedBytes: 2048,
      truncated: false,
      path: "C:/logs/cognia-structured.log",
    },
    files: [],
    loading: false,
    available: true,
    refresh: jest.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  useNativeLogQueryMock.mockReset()
  useNativeLogQueryMock.mockReturnValue(makeState())
})

describe("NativeLogViewer", () => {
  it("renders entries with level, target and message", () => {
    render(<NativeLogViewer />)

    expect(screen.getByText("slow response")).toBeInTheDocument()
    expect(screen.getByText("send failed")).toBeInTheDocument()
    expect(screen.getByText("network::lark")).toBeInTheDocument()
    expect(screen.getByText("warn")).toBeInTheDocument()
    expect(screen.getByText("error")).toBeInTheDocument()
  })

  it("shows the file path and entry count metadata", () => {
    render(<NativeLogViewer />)

    expect(screen.getByText("C:/logs/cognia-structured.log")).toBeInTheDocument()
    expect(screen.getByText(/2 entries/)).toBeInTheDocument()
  })

  it("shows the truncated badge when the scan window missed older entries", () => {
    const state = makeState()
    ;(state.result as { truncated: boolean }).truncated = true
    useNativeLogQueryMock.mockReturnValue(state)

    render(<NativeLogViewer />)
    expect(screen.getByText(/older entries beyond scan window/i)).toBeInTheDocument()
  })

  it("renders the unavailable state with a retry action", async () => {
    const refresh = jest.fn()
    useNativeLogQueryMock.mockReturnValue(makeState({ available: false, result: null, refresh }))
    const user = userEvent.setup()

    render(<NativeLogViewer />)

    expect(screen.getByText(/native logs unavailable/i)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /retry/i }))
    expect(refresh).toHaveBeenCalled()
  })

  it("renders an empty state when there are no entries", () => {
    const state = makeState()
    ;(state.result as { entries: unknown[] }).entries = []
    useNativeLogQueryMock.mockReturnValue(state)

    render(<NativeLogViewer />)
    expect(screen.getByText(/no matching entries/i)).toBeInTheDocument()
  })

  it("debounces the search input into the query", async () => {
    jest.useFakeTimers()
    try {
      const setQuery = jest.fn()
      useNativeLogQueryMock.mockReturnValue(makeState({ setQuery }))
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })

      render(<NativeLogViewer />)
      await user.type(screen.getByRole("textbox", { name: /search native logs/i }), "fail")

      expect(setQuery).not.toHaveBeenCalledWith({ contains: "fail" })
      jest.advanceTimersByTime(400)
      expect(setQuery).toHaveBeenCalledWith({ contains: "fail" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("changes the minimum level through the level select", async () => {
    const setQuery = jest.fn()
    useNativeLogQueryMock.mockReturnValue(makeState({ setQuery }))
    const user = userEvent.setup()

    render(<NativeLogViewer />)
    await user.click(screen.getByRole("combobox", { name: /minimum level/i }))
    await user.click(screen.getByRole("option", { name: "warn" }))

    expect(setQuery).toHaveBeenCalledWith({ minLevel: "warn" })
  })

  it("triggers a refresh from the refresh button", async () => {
    const refresh = jest.fn()
    useNativeLogQueryMock.mockReturnValue(makeState({ refresh }))
    const user = userEvent.setup()

    render(<NativeLogViewer />)
    await user.click(screen.getByRole("button", { name: /refresh/i }))
    expect(refresh).toHaveBeenCalled()
  })
})
