/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginMarketplaceDetail } from "./plugin-marketplace-detail"
import type { PluginPermission } from "@/types/plugin"

const detail = {
  id: "p1",
  name: "Plugin One",
  version: "1.0.0",
  type: "plugin",
  description: "Test description",
  author: "Acme",
  license: "MIT",
  homepage: "https://example.com",
  repository: "https://github.com/acme/p",
  capabilities: ["tools", "themes"],
  permissions: ["clipboard:read", "shell:execute"] as PluginPermission[],
  optionalPermissions: ["network:fetch"] as PluginPermission[],
  dependencies: { "@cognia/core": "^1.0.0" },
  readme: "## Hello\nReadme body.",
  signed: true,
}

describe("PluginMarketplaceDetail", () => {
  it("renders nothing when entry is null even if open=true", () => {
    const { container } = render(
      <PluginMarketplaceDetail
        open
        entry={null}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    // Sheet still mounts a portal, but the body content is empty.
    expect(container.textContent ?? "").toBe("")
  })

  it("renders entry metadata + install CTA", () => {
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
      />
    )
    expect(screen.getByText("Plugin One")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    expect(screen.getByText("MIT")).toBeInTheDocument()
    expect(screen.getByText("install")).toBeInTheDocument()
  })

  it("install click invokes onInstall", () => {
    const onInstall = jest.fn()
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed={false}
        installing={false}
        onClose={() => {}}
        onInstall={onInstall}
        onUninstall={() => {}}
      />
    )
    fireEvent.click(screen.getByText("install"))
    expect(onInstall).toHaveBeenCalledWith("p1", "1.0.0")
  })

  it("when installed, uninstall click invokes onUninstall", () => {
    const onUninstall = jest.fn()
    render(
      <PluginMarketplaceDetail
        open
        entry={detail}
        installed
        installing={false}
        onClose={() => {}}
        onInstall={() => {}}
        onUninstall={onUninstall}
      />
    )
    fireEvent.click(screen.getByText("uninstall"))
    expect(onUninstall).toHaveBeenCalledWith("p1")
  })
})
