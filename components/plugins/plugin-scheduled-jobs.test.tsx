/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within } from "@testing-library/react"
import type { PluginScheduledJobRow } from "@/lib/db/plugin-types"

let mockJobs: PluginScheduledJobRow[] | undefined

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockJobs,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginScheduledJobs: {
      orderBy: () => ({ toArray: async () => mockJobs ?? [] }),
    },
  }),
}))

import { PluginScheduledJobs } from "./plugin-scheduled-jobs"

function makeJob(overrides: Partial<PluginScheduledJobRow> = {}): PluginScheduledJobRow {
  return {
    id: "job-1",
    pluginId: "plugin-a",
    cron: "*/5 * * * *",
    handler: "doThing",
    args: {},
    status: "active",
    nextRunAt: 1_700_000_000_000,
    lastRunAt: 1_699_000_000_000,
    createdAt: 1_698_000_000_000,
    updatedAt: 1_698_000_000_000,
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
      makeJob({ id: "3", pluginId: "gamma", status: "error" }),
    ]
    render(<PluginScheduledJobs />)
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.getByText("gamma")).toBeInTheDocument()

    // The mock i18n translator returns the raw key. Click the paused chip
    // (label = "status.paused") and confirm only the paused row remains.
    fireEvent.click(screen.getByRole("button", { name: /status\.paused/i }))
    expect(screen.queryByText("alpha")).not.toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.queryByText("gamma")).not.toBeInTheDocument()
  })

  it("hides the handler column on narrow viewports via hidden sm:table-cell", () => {
    mockJobs = [makeJob({ pluginId: "plugin_x", handler: "myHandler", cron: "0 * * * *" })]
    render(<PluginScheduledJobs />)
    const handlerCell = screen.getByText("myHandler").closest("td")
    expect(handlerCell?.className).toContain("hidden")
    expect(handlerCell?.className).toContain("sm:table-cell")
  })
})
