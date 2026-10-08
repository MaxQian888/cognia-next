/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SessionUsageRow } from "@/lib/db/session-usage"

// Echo keys + params so assertions pin both the copy key and what fed it.
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useNow: () => mockNow,
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockNow = new Date(2026, 9, 7, 15, 30)
let rowsResult: SessionUsageRow[] | undefined = []
let lastQuery: (() => unknown) | undefined
let lastDeps: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => unknown, deps: unknown[]) => {
    lastQuery = fn
    lastDeps = deps
    return rowsResult
  },
}))

const aboveOrEqual = jest.fn(() => ({ toArray: () => Promise.resolve([]) }))
const where = jest.fn(() => ({ aboveOrEqual }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessionUsage: { where } }),
}))

const requestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: { requestOpenSettings: jest.Mock }) => unknown) =>
    selector({ requestOpenSettings }),
}))

import { StatusBarToday } from "./status-bar-today"

function row(over: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: "m",
    sessionId: "s1",
    at: mockNow.getTime() - 60_000,
    model: "claude-sonnet-5-5",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    durationMs: 1000,
    ...over,
  } as SessionUsageRow
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

beforeEach(() => {
  mockNow = new Date(2026, 9, 7, 15, 30)
  rowsResult = []
  lastQuery = undefined
  lastDeps = []
  jest.clearAllMocks()
})

describe("StatusBarToday", () => {
  it("renders nothing until today has a turn", () => {
    const { container } = render(<StatusBarToday />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing while the query is still loading", () => {
    rowsResult = undefined
    const { container } = render(<StatusBarToday />)
    expect(container).toBeEmptyDOMElement()
  })

  it("reads only today's rows, through the indexed `at` column", async () => {
    render(<StatusBarToday />)
    expect(lastDeps).toEqual([midnight(mockNow)])
    await lastQuery?.()
    expect(where).toHaveBeenCalledWith("at")
    expect(aboveOrEqual).toHaveBeenCalledWith(midnight(mockNow))
  })

  it("rolls the day boundary over at midnight", () => {
    const { rerender } = render(<StatusBarToday />)
    const today = lastDeps[0]
    mockNow = new Date(2026, 9, 8, 0, 1)
    rerender(<StatusBarToday />)
    expect(lastDeps[0]).toBe(midnight(mockNow))
    expect(lastDeps[0]).not.toBe(today)
  })

  it("shows today's tokens, and the cost once a priced turn has run", () => {
    rowsResult = [
      row({ messageId: "a", costUsd: 0.25 }),
      row({ messageId: "b", sessionId: "s2", costUsd: 0.5 }),
    ]
    render(<StatusBarToday />)
    const chip = screen.getByTestId("status-today")
    expect(chip).toHaveTextContent("3.0K")
    expect(chip).toHaveTextContent("$0.75")
    expect(chip).toHaveAttribute(
      "aria-label",
      `label:${JSON.stringify({ summary: `summaryWithCost:${JSON.stringify({ tokens: "3.0K", cost: "$0.75" })}` })}`
    )
  })

  it("leaves the cost out while nothing today was priced", () => {
    rowsResult = [row({ model: "local-model-without-pricing" })]
    render(<StatusBarToday />)
    const chip = screen.getByTestId("status-today")
    expect(chip).not.toHaveTextContent("$")
    expect(chip.getAttribute("aria-label")).toContain("summary:")
  })

  it("breaks the day down in its popover and links to the usage page", async () => {
    const user = userEvent.setup()
    rowsResult = [
      row({ messageId: "a", costUsd: 0.25 }),
      row({ messageId: "b", costUsd: 0.25 }),
      row({ messageId: "c", sessionId: "s2", costUsd: 0.25 }),
    ]
    render(<StatusBarToday />)
    await user.click(screen.getByTestId("status-today"))
    const details = await screen.findByTestId("status-today-details")
    // Two conversations, three turns, and the model that did the work.
    expect(details).toHaveTextContent("sessions2")
    expect(details).toHaveTextContent("turns3")
    expect(details).toHaveTextContent("claude-sonnet-5-5")
    await user.click(screen.getByTestId("status-today-open"))
    expect(requestOpenSettings).toHaveBeenCalledWith("subscription")
  })
})
