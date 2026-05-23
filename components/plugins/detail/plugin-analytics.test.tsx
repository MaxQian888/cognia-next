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
})
