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
    render(<PluginDiscovery onInstall={jest.fn()} />)
    await waitFor(() => expect(screen.getByText("Plugin 1")).toBeInTheDocument())
  })

  it("install button delegates to the onInstall prop with id + version", async () => {
    const onInstall = jest.fn()
    render(<PluginDiscovery onInstall={onInstall} />)
    await waitFor(() => expect(screen.getByText("Plugin 1")).toBeInTheDocument())
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith("p1", "1.0.0")
  })

  it("does NOT call the marketplace client install directly when the user clicks install", async () => {
    const directInstall = jest.fn(async () => undefined)
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => SAMPLE),
      getFeaturedPlugins: jest.fn(async () => SAMPLE),
      getPopularPlugins: jest.fn(async () => SAMPLE),
      getRecentPlugins: jest.fn(async () => SAMPLE),
      getPlugin: jest.fn(async () => null),
      installPlugin: directInstall,
      uninstallPlugin: jest.fn(async () => undefined),
    })
    const onInstall = jest.fn()
    render(<PluginDiscovery onInstall={onInstall} />)
    await waitFor(() => expect(screen.getByText("Plugin 1")).toBeInTheDocument())
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith("p1", "1.0.0")
    // The pre-install chain owns the install — the marketplace client must
    // not be invoked directly from the discovery surface.
    expect(directInstall).not.toHaveBeenCalled()
  })
})
