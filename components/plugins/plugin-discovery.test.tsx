/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  // `InstallButton` gates install on the desktop host, because the download
  // and checksum verification run in the Rust backend. These suites are about
  // what the surface renders and what it calls, not about the gate, which has
  // its own tests in `_shared/install-button.test.tsx`.
  canUseTauriInvoke: () => true,
}))

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
    const { container } = render(<PluginDiscovery onInstall={jest.fn()} />)
    await waitFor(() => expect(screen.getByText("Plugin 1")).toBeInTheDocument())
    expect(container.querySelector("[data-slot='card-header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-content']")).not.toBeNull()
    expect(container.querySelector("[data-slot='card-footer']")).not.toBeNull()
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
