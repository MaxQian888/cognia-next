/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
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
      {
        id: "job1",
        pluginId: "plugin_a",
        cron: "0 * * * *",
        handler: "myHandler",
        status: "active",
        nextRunAt: 1735689600000,
        lastRunAt: 1735603200000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "job2",
        pluginId: "plugin_b",
        cron: "@daily",
        handler: "dailyHandler",
        status: "paused",
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    render(<PluginScheduledJobs />)
    expect(screen.getByText("plugin_a")).toBeInTheDocument()
    expect(screen.getByText("0 * * * *")).toBeInTheDocument()
    expect(screen.getByText("myHandler")).toBeInTheDocument()
    expect(screen.getByText("plugin_b")).toBeInTheDocument()
  })
})
