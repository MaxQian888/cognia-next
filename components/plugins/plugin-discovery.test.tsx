/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { __resetPluginMarketplaceClientForTests } from "@/hooks/plugins"
import { PluginDiscovery } from "./plugin-discovery"

const SAMPLE = [
  {
    id: "p1",
    name: "Plugin 1",
    version: "1.0.0",
    type: "plugin",
    description: "",
  },
]

beforeEach(() => {
  __resetPluginMarketplaceClientForTests({
    searchPlugins: jest.fn(async () => SAMPLE),
    getFeaturedPlugins: jest.fn(async () => SAMPLE),
    getPopularPlugins: jest.fn(async () => SAMPLE),
    getRecentPlugins: jest.fn(async () => SAMPLE),
    getPlugin: jest.fn(async () => null),
    installPlugin: jest.fn(async () => undefined),
    uninstallPlugin: jest.fn(async () => undefined),
  })
})

describe("PluginDiscovery", () => {
  it("renders featured entries returned by the marketplace", async () => {
    render(<PluginDiscovery />)
    await waitFor(() => expect(screen.getByText("Plugin 1")).toBeInTheDocument())
  })

  it("install button invokes the marketplace client", async () => {
    const install = jest.fn(async () => undefined)
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => SAMPLE),
      getFeaturedPlugins: jest.fn(async () => SAMPLE),
      getPopularPlugins: jest.fn(async () => SAMPLE),
      getRecentPlugins: jest.fn(async () => SAMPLE),
      getPlugin: jest.fn(async () => null),
      installPlugin: install,
      uninstallPlugin: jest.fn(async () => undefined),
    })
    render(<PluginDiscovery />)
    await waitFor(() => expect(screen.getByText("Plugin 1")).toBeInTheDocument())
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => expect(install).toHaveBeenCalledWith("p1", "1.0.0"))
  })
})
