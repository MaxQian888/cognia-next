import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { RecentErrorsPanel, isCascading, type RecentErrorsCopy } from "./recent-errors-panel"
import { recordRecentErrorLog, resetRecentErrorLogsForTest } from "@cognia/logging/recent-errors"
import type { StructuredLogEntry } from "@/types/logging"

const copy: RecentErrorsCopy = {
  title: "Recent errors",
  cascadeHint: "Several errors occurred together — this may be a cascade.",
}

function entry(id: string, timestamp: string, message: string): StructuredLogEntry {
  return { id, timestamp, level: "error", message, module: "app" } as StructuredLogEntry
}

beforeEach(() => {
  resetRecentErrorLogsForTest()
})

describe("RecentErrorsPanel", () => {
  it("renders null when there are no recent errors", () => {
    const { container } = render(<RecentErrorsPanel copy={copy} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists recent errors once expanded", async () => {
    act(() => {
      recordRecentErrorLog(entry("e1", "2026-06-23T10:00:00.000Z", "first failure"))
      recordRecentErrorLog(entry("e2", "2026-06-23T10:00:01.000Z", "second failure"))
    })
    render(<RecentErrorsPanel copy={copy} />)
    expect(screen.getByTestId("recent-errors-panel")).toBeInTheDocument()

    await userEvent.click(screen.getByTestId("recent-errors-toggle"))
    expect(screen.getAllByTestId("recent-errors-item")).toHaveLength(2)
    expect(screen.getByText("first failure")).toBeInTheDocument()
    expect(screen.getByText("second failure")).toBeInTheDocument()
  })

  it("excludes the current boundary error by id", async () => {
    act(() => {
      recordRecentErrorLog(entry("current", "2026-06-23T10:00:00.000Z", "current crash"))
      recordRecentErrorLog(entry("other", "2026-06-23T10:00:02.000Z", "other crash"))
    })
    render(<RecentErrorsPanel copy={copy} currentErrorId="current" />)
    await userEvent.click(screen.getByTestId("recent-errors-toggle"))
    expect(screen.getAllByTestId("recent-errors-item")).toHaveLength(1)
    expect(screen.queryByText("current crash")).toBeNull()
  })

  it("shows the cascade hint when ≥3 errors land within 5s", async () => {
    act(() => {
      recordRecentErrorLog(entry("a", "2026-06-23T10:00:00.000Z", "a"))
      recordRecentErrorLog(entry("b", "2026-06-23T10:00:01.000Z", "b"))
      recordRecentErrorLog(entry("c", "2026-06-23T10:00:02.000Z", "c"))
    })
    render(<RecentErrorsPanel copy={copy} />)
    await userEvent.click(screen.getByTestId("recent-errors-toggle"))
    expect(screen.getByTestId("recent-errors-cascade")).toBeInTheDocument()
  })

  it("reacts to new errors via the subscription", async () => {
    act(() => {
      recordRecentErrorLog(entry("e1", "2026-06-23T10:00:00.000Z", "first"))
    })
    render(<RecentErrorsPanel copy={copy} />)
    await userEvent.click(screen.getByTestId("recent-errors-toggle"))
    expect(screen.getAllByTestId("recent-errors-item")).toHaveLength(1)

    act(() => {
      recordRecentErrorLog(entry("e2", "2026-06-23T10:00:01.000Z", "second"))
    })
    expect(screen.getAllByTestId("recent-errors-item")).toHaveLength(2)
  })
})

describe("isCascading", () => {
  it("is false below the threshold", () => {
    expect(isCascading([entry("a", "2026-06-23T10:00:00.000Z", "a")])).toBe(false)
  })

  it("is true for 3 close-together errors", () => {
    expect(
      isCascading([
        entry("a", "2026-06-23T10:00:00.000Z", "a"),
        entry("b", "2026-06-23T10:00:01.000Z", "b"),
        entry("c", "2026-06-23T10:00:04.000Z", "c"),
      ])
    ).toBe(true)
  })

  it("is false when the spread exceeds the window", () => {
    expect(
      isCascading([
        entry("a", "2026-06-23T10:00:00.000Z", "a"),
        entry("b", "2026-06-23T10:00:03.000Z", "b"),
        entry("c", "2026-06-23T10:00:30.000Z", "c"),
      ])
    ).toBe(false)
  })

  it("ignores unparseable timestamps", () => {
    expect(
      isCascading([
        entry("a", "nonsense", "a"),
        entry("b", "also-bad", "b"),
        entry("c", "still-bad", "c"),
      ])
    ).toBe(false)
  })
})
