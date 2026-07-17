/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { PluginDetail } from "./plugin-detail"

let mockTask: Record<string, unknown> | null = null
const mockRuns: unknown[] = []

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockTask }))
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: mockRuns, isLoading: false }),
}))

describe("PluginDetail", () => {
  beforeEach(() => {
    mockTask = null
    mockRuns.length = 0
  })

  it("renders the not-found state without a SchedulerDB task", () => {
    render(<PluginDetail jobId="missing" />)
    expect(screen.getByText("pluginJobNotFound")).toBeInTheDocument()
  })

  it("renders plugin payload and schedule from the real task shape", () => {
    mockTask = {
      id: "task-1",
      payload: { pluginId: "vendor.plugin", handler: "sync", args: { full: true } },
      trigger: { type: "cron", cronExpression: "0 9 * * *" },
      status: "active",
      nextRunAt: new Date("2026-07-17T01:00:00Z"),
      lastRunAt: new Date("2026-07-16T01:00:00Z"),
    }
    render(<PluginDetail jobId="task-1" />)

    expect(screen.getByText("vendor.plugin")).toBeInTheDocument()
    expect(screen.getByText("sync")).toBeInTheDocument()
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-args-block")).toHaveTextContent('"full": true')
    expect(screen.getByRole("link", { name: /openInPluginSettings/ })).toHaveAttribute(
      "href",
      "/settings?section=plugins&pluginId=vendor.plugin"
    )
  })
})
