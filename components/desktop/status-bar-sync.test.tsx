/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

jest.mock("@cognia/time", () => ({
  formatRelative: (ts: number) => `rel(${ts})`,
}))

const mockSnapshot = jest.fn()
const mockRunSyncDown = jest.fn()
jest.mock("@/lib/sync/companion-sync", () => ({
  snapshotSyncStates: () => mockSnapshot(),
  runSyncDown: () => mockRunSyncDown(),
}))

import { StatusBarSync } from "./status-bar-sync"

beforeEach(() => {
  mockSnapshot.mockReset()
  mockRunSyncDown.mockReset()
  mockRunSyncDown.mockResolvedValue([])
})

describe("StatusBarSync", () => {
  it("shows 'never synced' when no table has a lastSyncAt", () => {
    mockSnapshot.mockReturnValue({
      a: { lastSyncAt: null, since: 0, lastError: null },
    })
    render(<StatusBarSync />)
    expect(screen.getByTestId("status-sync")).toHaveAttribute("title", "syncNever")
  })

  it("shows the most-recent lastSyncAt across tables", () => {
    mockSnapshot.mockReturnValue({
      a: { lastSyncAt: 1000, since: 0, lastError: null },
      b: { lastSyncAt: 5000, since: 0, lastError: null },
    })
    render(<StatusBarSync />)
    // syncLast:{"time":"rel(5000)"} — the newest stamp wins.
    expect(screen.getByTestId("status-sync")).toHaveAttribute(
      "title",
      'syncLast:{"time":"rel(5000)"}'
    )
  })

  it("tints on a table error", () => {
    mockSnapshot.mockReturnValue({
      a: { lastSyncAt: 1000, since: 0, lastError: "boom" },
    })
    const { container } = render(<StatusBarSync />)
    expect(container.querySelector(".text-amber-500")).not.toBeNull()
  })

  it("runs a full sync on click, then refreshes", async () => {
    mockSnapshot.mockReturnValue({ a: { lastSyncAt: 1000, since: 0, lastError: null } })
    render(<StatusBarSync />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("status-sync"))
    })
    expect(mockRunSyncDown).toHaveBeenCalledTimes(1)
    // refresh() re-reads the snapshot after the sync settles.
    await waitFor(() => expect(mockSnapshot.mock.calls.length).toBeGreaterThan(1))
  })

  it("polls the snapshot on an interval", () => {
    jest.useFakeTimers()
    mockSnapshot.mockReturnValue({ a: { lastSyncAt: 1000, since: 0, lastError: null } })
    try {
      render(<StatusBarSync />)
      const before = mockSnapshot.mock.calls.length
      act(() => {
        jest.advanceTimersByTime(15_000)
      })
      expect(mockSnapshot.mock.calls.length).toBeGreaterThan(before)
    } finally {
      jest.useRealTimers()
    }
  })
})
