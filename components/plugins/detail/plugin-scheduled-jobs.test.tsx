/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within } from "@testing-library/react"
import type { PluginScheduledJobView } from "./plugin-scheduled-jobs"

let mockJobs: PluginScheduledJobView[] | undefined
const mockNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
  // Sentinel formatter + fixed clock: pins the run columns to next-intl's
  // locale-aware formatting (and the options / reference instant it uses),
  // not a raw UTC ISO slice.
  useFormatter: () => ({
    dateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      `fmt:${new Date(value).toISOString()}:${options?.dateStyle ?? "-"}/${options?.timeStyle ?? "-"}`,
    relativeTime: (value: Date | number, now: Date | number) =>
      `rel:${new Date(value).toISOString()}@${new Date(now).toISOString()}`,
  }),
  useNow: () => mockNow,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockJobs,
}))

import { PluginScheduledJobs } from "./plugin-scheduled-jobs"

function makeJob(overrides: Partial<PluginScheduledJobView> = {}): PluginScheduledJobView {
  return {
    id: "job-1",
    pluginId: "plugin-a",
    cron: "*/5 * * * *",
    handler: "doThing",
    status: "active",
    nextRunAt: 1_700_000_000_000,
    lastRunAt: 1_699_000_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  mockJobs = undefined
})

describe("PluginScheduledJobs", () => {
  it("shows loading hint while jobs are undefined", () => {
    mockJobs = undefined
    render(<PluginScheduledJobs />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("renders empty state with deep link when no jobs", () => {
    mockJobs = []
    render(<PluginScheduledJobs />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    const link = screen.getByText("openScheduler").closest("a")
    expect(link).toHaveAttribute("href", "/settings?section=scheduled-tasks")
  })

  it("renders one row per job", () => {
    mockJobs = [
      makeJob({
        id: "job1",
        pluginId: "plugin_a",
        cron: "0 * * * *",
        handler: "myHandler",
        status: "active",
      }),
      makeJob({
        id: "job2",
        pluginId: "plugin_b",
        cron: "@daily",
        handler: "dailyHandler",
        status: "paused",
        nextRunAt: undefined,
        lastRunAt: undefined,
      }),
    ]
    render(<PluginScheduledJobs />)
    expect(screen.getByText("plugin_a")).toBeInTheDocument()
    expect(screen.getByText("0 * * * *")).toBeInTheDocument()
    expect(screen.getByText("myHandler")).toBeInTheDocument()
    expect(screen.getByText("plugin_b")).toBeInTheDocument()
  })

  it("sorts by pluginId ascending then descending when the header is clicked", () => {
    mockJobs = [
      makeJob({ id: "1", pluginId: "zeta" }),
      makeJob({ id: "2", pluginId: "alpha" }),
      makeJob({ id: "3", pluginId: "mike" }),
    ]
    render(<PluginScheduledJobs />)
    const headerBtn = screen.getByTestId("plugin-jobs-sort-pluginId")
    fireEvent.click(headerBtn)
    let rows = screen.getAllByRole("row").slice(1)
    expect(within(rows[0]).getByText("alpha")).toBeInTheDocument()
    expect(within(rows[2]).getByText("zeta")).toBeInTheDocument()

    fireEvent.click(headerBtn)
    rows = screen.getAllByRole("row").slice(1)
    expect(within(rows[0]).getByText("zeta")).toBeInTheDocument()
    expect(within(rows[2]).getByText("alpha")).toBeInTheDocument()
  })

  it("filters by status when a chip is clicked", () => {
    mockJobs = [
      makeJob({ id: "1", pluginId: "alpha", status: "active" }),
      makeJob({ id: "2", pluginId: "beta", status: "paused" }),
      makeJob({ id: "3", pluginId: "gamma", status: "disabled" }),
    ]
    render(<PluginScheduledJobs />)
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.getByText("gamma")).toBeInTheDocument()

    // The mock i18n translator returns the raw key. Click the paused chip
    // (label = "status.paused") and confirm only the paused row remains.
    fireEvent.click(screen.getByRole("radio", { name: /status\.paused/i }))
    expect(screen.queryByText("alpha")).not.toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.queryByText("gamma")).not.toBeInTheDocument()
  })

  it("renders labels for every available status filter", () => {
    mockJobs = [
      makeJob({ id: "1", pluginId: "alpha", status: "active" }),
      makeJob({ id: "2", pluginId: "beta", status: "paused" }),
      makeJob({ id: "3", pluginId: "gamma", status: "disabled" }),
    ]
    render(<PluginScheduledJobs />)

    expect(screen.getByRole("radio", { name: "status.all 3" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "status.active 1" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "status.paused 1" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "status.disabled 1" })).toBeInTheDocument()
  })

  it("hides the handler column on narrow viewports via hidden sm:table-cell", () => {
    mockJobs = [makeJob({ pluginId: "plugin_x", handler: "myHandler", cron: "0 * * * *" })]
    render(<PluginScheduledJobs />)
    const handlerCell = screen.getByText("myHandler").closest("td")
    expect(handlerCell?.className).toContain("hidden")
    expect(handlerCell?.className).toContain("sm:table-cell")
  })

  it("filters to a single plugin when pluginId is set", () => {
    mockJobs = [
      makeJob({ id: "1", pluginId: "alpha", cron: "0 * * * *" }),
      makeJob({ id: "2", pluginId: "beta", cron: "*/5 * * * *" }),
      makeJob({ id: "3", pluginId: "alpha", cron: "@daily" }),
    ]
    render(<PluginScheduledJobs pluginId="alpha" />)
    expect(screen.getAllByText("alpha")).toHaveLength(2)
    expect(screen.queryByText("beta")).not.toBeInTheDocument()
  })

  it("renders next run relative to now and last run as a localized absolute time", () => {
    const next = Date.UTC(2026, 4, 21, 12, 5, 0)
    const last = Date.UTC(2026, 4, 21, 11, 0, 0)
    mockJobs = [makeJob({ pluginId: "plugin_t", nextRunAt: next, lastRunAt: last })]
    render(<PluginScheduledJobs />)

    const nextTime = screen.getByText("rel:2026-05-21T12:05:00.000Z@2026-05-21T12:00:00.000Z")
    expect(nextTime.tagName).toBe("TIME")
    expect(nextTime).toHaveAttribute("dateTime", "2026-05-21T12:05:00.000Z")
    expect(nextTime).toHaveAttribute("title", "fmt:2026-05-21T12:05:00.000Z:medium/short")

    const lastTime = screen.getByText("fmt:2026-05-21T11:00:00.000Z:medium/short")
    expect(lastTime.tagName).toBe("TIME")
    expect(lastTime).toHaveAttribute("dateTime", "2026-05-21T11:00:00.000Z")
    expect(lastTime).not.toHaveAttribute("title")

    expect(screen.queryByText("2026-05-21 12:05")).not.toBeInTheDocument()
  })

  it("renders an em dash for a missing or unparseable run time", () => {
    mockJobs = [makeJob({ pluginId: "plugin_d", nextRunAt: undefined, lastRunAt: Number.NaN })]
    const { container } = render(<PluginScheduledJobs />)
    const row = screen.getByText("plugin_d").closest("tr") as HTMLElement
    expect(within(row).getAllByText("—")).toHaveLength(2)
    expect(container.querySelector("time")).toBeNull()
    expect(container.textContent).not.toContain("Invalid Date")
  })

  it("renders the empty state when pluginId has no jobs", () => {
    mockJobs = [makeJob({ pluginId: "other", cron: "0 * * * *" })]
    render(<PluginScheduledJobs pluginId="alpha" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
