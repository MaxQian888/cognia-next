import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ dateTime: () => "12:04:31" }),
}))
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 30,
        size: 30,
        end: (index + 1) * 30,
        lane: 0,
      })),
    getTotalSize: () => count * 30,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))

import type { SiteLogEntry } from "@/lib/sites/cloudflare/observability-parse"
import { SiteLogTable } from "./site-log-table"

function entry(overrides: Partial<SiteLogEntry> = {}): SiteLogEntry {
  return {
    id: "e1",
    timestamp: 1_700_000_000_000,
    level: "info",
    message: "hello",
    raw: { original: true },
    ...overrides,
  }
}

it("renders one row per event with its level, message, and status", () => {
  render(
    <SiteLogTable
      view={{
        entries: [entry({ level: "error", message: "boom", statusCode: 500 })],
        unparsed: 0,
        unrecognized: false,
      }}
    />
  )
  const row = screen.getByTestId("site-log-row-e1")
  expect(row).toHaveTextContent("observability.level.error")
  expect(row).toHaveTextContent("boom")
  expect(row).toHaveTextContent("500")
})

it("expands to the original event, which the row summary flattens", () => {
  render(<SiteLogTable view={{ entries: [entry()], unparsed: 0, unrecognized: false }} />)
  expect(screen.queryByTestId("site-log-detail-e1")).not.toBeInTheDocument()
})

it("toggles a row's detail open and shut", async () => {
  const user = userEvent.setup()
  render(<SiteLogTable view={{ entries: [entry()], unparsed: 0, unrecognized: false }} />)
  await user.click(screen.getByTestId("site-log-row-e1"))
  expect(screen.getByTestId("site-log-detail-e1")).toBeInTheDocument()
  await user.click(screen.getByTestId("site-log-row-e1"))
  expect(screen.queryByTestId("site-log-detail-e1")).not.toBeInTheDocument()
})

it("says how many events it could not read rather than dropping them silently", () => {
  // A partial read must not look like a quiet period.
  render(<SiteLogTable view={{ entries: [entry()], unparsed: 3, unrecognized: false }} />)
  expect(screen.getByTestId("site-log-unparsed")).toHaveTextContent(
    'observability.logs.unparsed:{"count":3}'
  )
})

it("shows an empty state, still counting anything unreadable", () => {
  render(<SiteLogTable view={{ entries: [], unparsed: 2, unrecognized: false }} />)
  expect(screen.getByTestId("site-log-table-empty")).toHaveTextContent("observability.logs.empty")
  expect(screen.getByTestId("site-log-table-empty")).toHaveTextContent(
    'observability.logs.unparsed:{"count":2}'
  )
})

it("prefers the request URL when an event carries no message", () => {
  render(
    <SiteLogTable
      view={{
        entries: [entry({ message: "", requestMethod: "GET", requestUrl: "https://x/api" })],
        unparsed: 0,
        unrecognized: false,
      }}
    />
  )
  expect(screen.getByTestId("site-log-row-e1")).toHaveTextContent("GET https://x/api")
})
