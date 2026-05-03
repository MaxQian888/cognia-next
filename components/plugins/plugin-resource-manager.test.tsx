/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginAnalyticsRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockRows: PluginAnalyticsRow[] = [
  {
    pluginId: "alpha",
    key: "tool.invoke",
    count: 42,
    lastEventAt: Date.now(),
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
})
