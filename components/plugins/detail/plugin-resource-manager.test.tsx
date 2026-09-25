/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginAnalyticsRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  // Sentinel formatter: pins the last-event line to next-intl's locale-aware
  // formatting (and the options it asks for), not a raw UTC ISO slice.
  useFormatter: () => ({
    dateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      `fmt:${new Date(value).toISOString()}:${options?.dateStyle ?? "-"}/${options?.timeStyle ?? "-"}`,
  }),
}))

const mockRows: PluginAnalyticsRow[] = [
  {
    pluginId: "alpha",
    key: "tool.invoke",
    count: 42,
    lastEventAt: Date.UTC(2026, 4, 21, 14, 30, 45),
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({
        reverse: () => ({ toArray: async () => mockRows }),
      }),
    },
  }),
}))

import { PluginResourceManager } from "./plugin-resource-manager"

describe("PluginResourceManager", () => {
  it("renders an empty card when no limits provided", () => {
    render(<PluginResourceManager pluginId="alpha" limits={[]} />)
    expect(screen.getByText("noLimits")).toBeInTheDocument()
  })

  it("renders one row per limit and surfaces the analytics counter", () => {
    render(
      <PluginResourceManager
        pluginId="alpha"
        limits={[
          { key: "tool.invoke", limit: 100, windowMs: 60_000 },
          { key: "hook.dispatch", limit: 500, windowMs: 60_000 },
        ]}
      />
    )
    expect(screen.getByText("tool.invoke")).toBeInTheDocument()
    expect(screen.getByText("hook.dispatch")).toBeInTheDocument()
    // The analytics counter for tool.invoke is 42 / 100.
    expect(screen.getByText("42 / 100")).toBeInTheDocument()
  })

  it("renders the last event time through the next-intl formatter, only where one exists", () => {
    const { container } = render(
      <PluginResourceManager
        pluginId="alpha"
        limits={[
          { key: "tool.invoke", limit: 100, windowMs: 60_000 },
          { key: "hook.dispatch", limit: 500, windowMs: 60_000 },
        ]}
      />
    )
    const time = screen.getByText("fmt:2026-05-21T14:30:45.000Z:medium/medium")
    expect(time.tagName).toBe("TIME")
    expect(time).toHaveAttribute("dateTime", "2026-05-21T14:30:45.000Z")
    // hook.dispatch has no analytics row, so it gets no time line.
    expect(container.querySelectorAll("time")).toHaveLength(1)
  })
})
