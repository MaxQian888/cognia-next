/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginAnalyticsRow, PluginRow } from "@/lib/db/plugin-types"

let mockAnalytics: PluginAnalyticsRow[] = []
let mockPlugins: PluginRow[] = []
let liveQueryCallIndex = 0

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // Sentinel formatter: pins the last-event column to next-intl's locale-aware
  // formatting (and the options it asks for), not a raw UTC ISO slice.
  useFormatter: () => ({
    dateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      `fmt:${new Date(value).toISOString()}:${options?.dateStyle ?? "-"}/${options?.timeStyle ?? "-"}`,
  }),
}))

// usePluginAnalytics calls useLiveQuery first; PluginAnalytics then calls
// useLiveQuery again for the plugins list. We sequence by render-call index
// (reset before each test) so the right seed array is returned for each.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => {
    const idx = liveQueryCallIndex
    liveQueryCallIndex += 1
    return idx === 0 ? mockAnalytics : mockPlugins
  },
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => mockAnalytics }) }),
    },
  }),
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => mockPlugins),
}))

import { PluginAnalytics } from "./plugin-analytics"

beforeEach(() => {
  mockAnalytics = []
  mockPlugins = []
  liveQueryCallIndex = 0
})

describe("PluginAnalytics", () => {
  it("renders empty state when no analytics events", () => {
    mockAnalytics = []
    render(<PluginAnalytics />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders summary cards and the per-plugin row", () => {
    mockAnalytics = [
      { pluginId: "alpha", key: "tool.invoke", count: 5, lastEventAt: 100 },
      { pluginId: "alpha", key: "hook.dispatch", count: 3, lastEventAt: 200 },
    ]
    mockPlugins = [
      {
        id: "alpha",
        name: "Alpha plugin",
        version: "1.0.0",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: [],
        path: "/",
        manifest: { id: "alpha" },
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    render(<PluginAnalytics />)
    expect(screen.getByText("Alpha plugin")).toBeInTheDocument()
    // "8" appears in both the summary card and the per-plugin row.
    expect(screen.getAllByText("8").length).toBeGreaterThan(0)
  })

  it("renders the latest event time through the next-intl formatter", () => {
    const at = Date.UTC(2026, 4, 21, 14, 30, 45)
    mockAnalytics = [
      { pluginId: "alpha", key: "tool.invoke", count: 5, lastEventAt: at - 60_000 },
      { pluginId: "alpha", key: "hook.dispatch", count: 3, lastEventAt: at },
    ]
    render(<PluginAnalytics />)
    const time = screen.getByText("fmt:2026-05-21T14:30:45.000Z:medium/medium")
    expect(time.tagName).toBe("TIME")
    expect(time).toHaveAttribute("dateTime", "2026-05-21T14:30:45.000Z")
    expect(screen.queryByText("2026-05-21 14:30:45")).not.toBeInTheDocument()
  })

  it("renders an em dash instead of an epoch or invalid date when no time is recorded", () => {
    mockAnalytics = [{ pluginId: "alpha", key: "tool.invoke", count: 1, lastEventAt: 0 }]
    const { container } = render(<PluginAnalytics />)
    expect(container.querySelector("time")).toBeNull()
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(container.textContent).not.toContain("1970")
    expect(container.textContent).not.toContain("Invalid Date")
  })
})
