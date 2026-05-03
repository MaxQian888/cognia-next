/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const installedRows: Array<{ id: string }> = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => installedRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => installedRows),
}))

import { __resetPluginMarketplaceClientForTests } from "@/hooks/plugins"
import { PluginMarketplace } from "./plugin-marketplace"

const ENTRIES = [
  {
    id: "alpha",
    name: "Alpha",
    version: "1.0.0",
    type: "plugin",
    description: "first",
  },
  {
    id: "beta",
    name: "Beta",
    version: "0.5.0",
    type: "plugin",
    description: "second",
  },
]

beforeEach(() => {
  installedRows.length = 0
  __resetPluginMarketplaceClientForTests({
    searchPlugins: jest.fn(async () => ENTRIES),
    getFeaturedPlugins: jest.fn(async () => ENTRIES.slice(0, 1)),
    getPopularPlugins: jest.fn(async () => ENTRIES),
    getRecentPlugins: jest.fn(async () => ENTRIES),
    installPlugin: jest.fn(async () => undefined),
    uninstallPlugin: jest.fn(async () => undefined),
  })
})

describe("PluginMarketplace", () => {
  it("renders cards from the marketplace state", async () => {
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })

  it("renders the section toggle group", async () => {
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    expect(screen.getByText("sections.featured")).toBeInTheDocument()
    expect(screen.getByText("sections.popular")).toBeInTheDocument()
    expect(screen.getByText("sections.recent")).toBeInTheDocument()
  })

  it("install click invokes the marketplace install path", async () => {
    const install = jest.fn(async () => undefined)
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => ENTRIES),
      getFeaturedPlugins: jest.fn(async () => ENTRIES),
      getPopularPlugins: jest.fn(async () => ENTRIES),
      getRecentPlugins: jest.fn(async () => ENTRIES),
      installPlugin: install,
      uninstallPlugin: jest.fn(async () => undefined),
    })
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument())
    const installButtons = screen.getAllByText("install")
    fireEvent.click(installButtons[0])
    await waitFor(() => expect(install).toHaveBeenCalled())
  })
})
