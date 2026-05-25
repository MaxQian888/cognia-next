/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginMarketplaceCard } from "./plugin-marketplace-card"

const baseEntry = {
  id: "p1",
  name: "Plugin One",
  version: "1.0.0",
  description: "Test plugin",
  author: "Acme",
  rating: 4.5,
  downloads: 1234,
  signed: true,
  type: "plugin",
  capabilities: ["tools", "themes", "commands", "hooks"],
  permissions: ["clipboard:read"],
}

const callbacks = () => ({
  onView: jest.fn(),
  onInstall: jest.fn(),
  onUninstall: jest.fn(),
})

describe("PluginMarketplaceCard", () => {
  it("renders core metadata", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    expect(screen.getByText("Plugin One")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    expect(screen.getByText("Acme")).toBeInTheDocument()
  })

  it("install button invokes onInstall with id + version", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    fireEvent.click(screen.getByText("install"))
    expect(cb.onInstall).toHaveBeenCalledWith("p1", "1.0.0")
  })

  it("clicking the title invokes onView", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    fireEvent.click(screen.getByText("Plugin One"))
    expect(cb.onView).toHaveBeenCalledWith("p1")
  })

  it("when installed, shows an uninstall button", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed installing={false} {...cb} />)
    fireEvent.click(screen.getByText("uninstall"))
    expect(cb.onUninstall).toHaveBeenCalledWith("p1")
  })

  it("highlights dangerous permissions", () => {
    const cb = callbacks()
    render(
      <PluginMarketplaceCard
        entry={{ ...baseEntry, permissions: ["shell:execute"] }}
        installed={false}
        installing={false}
        {...cb}
      />
    )
    expect(screen.getByText("dangerous")).toBeInTheDocument()
  })

  it("for a built-in entry, shows the Built-in badge and no install/uninstall button", () => {
    const cb = callbacks()
    render(
      <PluginMarketplaceCard
        entry={{ ...baseEntry, source: "builtin" as const }}
        installed
        installing={false}
        {...cb}
      />
    )
    expect(screen.getByTestId("plugin-source-badge-builtin")).toBeInTheDocument()
    expect(screen.queryByText("install")).not.toBeInTheDocument()
    expect(screen.queryByText("uninstall")).not.toBeInTheDocument()
  })

  it("renders the click-card region as a real <button> so it inherits keyboard focus", () => {
    const cb = callbacks()
    render(<PluginMarketplaceCard entry={baseEntry} installed={false} installing={false} {...cb} />)
    // The Button asChild wrapper merges shadcn focus styling onto the inner
    // <button>. The DOM should still expose a single button with type="button"
    // whose accessible name resolves through the visible name + id text.
    const region = screen.getByText("Plugin One").closest("button")
    expect(region).not.toBeNull()
    expect(region).toHaveAttribute("type", "button")
  })
})
