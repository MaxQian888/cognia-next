/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockRows: PluginRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows)),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
  }),
}))

import PluginsRoutePage from "./page"

describe("PluginsRoutePage", () => {
  it("renders the PluginPanel inside an h-svh container", () => {
    const { container } = render(<PluginsRoutePage />)
    expect(container.querySelector(".h-svh")).toBeInTheDocument()
    // Header label key should appear (from mocked next-intl).
    expect(screen.getByText("title")).toBeInTheDocument()
  })
})
