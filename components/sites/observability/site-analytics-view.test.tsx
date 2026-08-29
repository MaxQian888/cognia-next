import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({
    "chart-2": "#009689",
    destructive: "#e7000b",
    "muted-foreground": "#888888",
  }),
}))
// recharts measures its container, which jsdom reports as zero.
jest.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: Passthrough,
    AreaChart: Passthrough,
    Area: Passthrough,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    LabelList: () => null,
  }
})

import type { SiteAnalyticsView } from "@/lib/sites/cloudflare/observability-parse"
import { SiteAnalyticsPanel } from "./site-analytics-view"

function view(overrides: Partial<SiteAnalyticsView> = {}): SiteAnalyticsView {
  return {
    worker: {
      points: [
        { date: "2026-08-01", requests: 1000, errors: 10, subrequests: 5 },
        { date: "2026-08-02", requests: 2000, errors: 30, subrequests: 7 },
      ],
      totals: { date: "", requests: 3000, errors: 40, subrequests: 12 },
    },
    providerErrors: [],
    unrecognized: false,
    ...overrides,
  }
}

it("leads with the four headline numbers, which are tiles rather than charts", () => {
  render(<SiteAnalyticsPanel view={view()} />)
  expect(screen.getByTestId("site-analytics-requests")).toHaveTextContent("3.0k")
  expect(screen.getByTestId("site-analytics-errors")).toHaveTextContent("40")
})

it("shows the error rate beside the count, not as a second axis", () => {
  // Requests and errors differ by orders of magnitude; one plot would flatten
  // errors onto the baseline and two y-axes would invent a correlation.
  render(<SiteAnalyticsPanel view={view()} />)
  expect(screen.getByTestId("site-analytics-errors")).toHaveTextContent("1.33%")
  expect(screen.getByTestId("site-analytics-requests-chart")).toBeInTheDocument()
  expect(screen.getByTestId("site-analytics-error-rate-chart")).toBeInTheDocument()
})

it("shows a dash rather than a zero for zone metrics it did not get", () => {
  // Without a zone id and a hostname the query returns worker data only;
  // rendering 0 page views would be a claim, not an absence.
  render(<SiteAnalyticsPanel view={view()} />)
  expect(screen.getByTestId("site-analytics-page-views")).toHaveTextContent("—")
})

it("shows zone metrics once the query returns them", () => {
  render(
    <SiteAnalyticsPanel
      view={view({
        web: {
          points: [
            { date: "2026-08-01", requests: 900, pageViews: 700, bytes: 2048, uniques: 120 },
          ],
          totals: { date: "", requests: 900, pageViews: 700, bytes: 2048, uniques: 120 },
        },
      })}
    />
  )
  expect(screen.getByTestId("site-analytics-page-views")).toHaveTextContent("700")
  expect(screen.getByTestId("site-analytics-uniques")).toHaveTextContent("120")
})

it("offers a table view, so identity is never colour-alone", async () => {
  const user = userEvent.setup()
  render(<SiteAnalyticsPanel view={view()} />)
  await user.click(screen.getByTestId("site-analytics-view-toggle"))
  const table = screen.getByTestId("site-analytics-table")
  expect(table).toHaveTextContent("2026-08-01")
  expect(table).toHaveTextContent("1000")
})

it("says when the provider only returned part of the answer", () => {
  render(<SiteAnalyticsPanel view={view({ providerErrors: ["rate limited"] })} />)
  expect(screen.getByTestId("site-analytics-partial")).toHaveTextContent("rate limited")
})

it("says there was no traffic rather than drawing an empty chart", () => {
  render(
    <SiteAnalyticsPanel
      view={view({
        worker: { points: [], totals: { date: "", requests: 0, errors: 0, subrequests: 0 } },
      })}
    />
  )
  expect(screen.getByTestId("site-analytics-empty")).toBeInTheDocument()
})
