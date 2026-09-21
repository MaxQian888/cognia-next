/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}))

import { PluginMarketplacePresetCard } from "./plugin-marketplace-preset-card"
import type { MarketplacePreset } from "@/lib/plugin/package/github-marketplace"

function member(name: string) {
  return {
    id: `acme/store:${name}`,
    name,
    version: "",
    type: "plugin",
    source: "git",
    github: { owner: "acme", repo: "store", subdir: `plugins/${name}` },
  } as MarketplacePreset["members"][number]
}

const basePreset: MarketplacePreset = {
  id: "acme/store:starter",
  name: "starter",
  description: "The essentials",
  members: [member("alpha"), member("beta")],
  missingPlugins: [],
}

describe("PluginMarketplacePresetCard", () => {
  it("renders the preset name, description and member chips", () => {
    render(<PluginMarketplacePresetCard preset={basePreset} busy={false} onInstall={jest.fn()} />)
    expect(screen.getByText("starter")).toBeInTheDocument()
    expect(screen.getByText("The essentials")).toBeInTheDocument()
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.getByTestId("preset-card-acme/store:starter")).toBeInTheDocument()
  })

  it("collapses members past the chip limit into a '+n more' badge", () => {
    const preset: MarketplacePreset = {
      ...basePreset,
      members: ["a", "b", "c", "d", "e", "f", "g", "h"].map(member),
    }
    render(<PluginMarketplacePresetCard preset={preset} busy={false} onInstall={jest.fn()} />)
    // 6 chips shown, the remaining 2 collapsed — "g"/"h" never render.
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("f")).toBeInTheDocument()
    expect(screen.queryByText("g")).not.toBeInTheDocument()
    expect(screen.getByText(/presets\.moreMembers/)).toBeInTheDocument()
    expect(screen.getByText(/"count":2/)).toBeInTheDocument()
  })

  it("surfaces catalog names the preset lists but no plugin carries", () => {
    const preset: MarketplacePreset = {
      ...basePreset,
      missingPlugins: ["ghost"],
    }
    render(<PluginMarketplacePresetCard preset={preset} busy={false} onInstall={jest.fn()} />)
    expect(screen.getByText(/presets\.missing/)).toBeInTheDocument()
    expect(screen.getByText(/"names":"ghost"/)).toBeInTheDocument()
  })

  it("forwards the preset to onInstall when the CTA is clicked", () => {
    const onInstall = jest.fn()
    render(<PluginMarketplacePresetCard preset={basePreset} busy={false} onInstall={onInstall} />)
    fireEvent.click(screen.getByTestId("preset-install-acme/store:starter"))
    expect(onInstall).toHaveBeenCalledTimes(1)
    expect(onInstall).toHaveBeenCalledWith(basePreset)
  })

  it("disables the CTA while busy and while the preset has no members", () => {
    const { rerender } = render(
      <PluginMarketplacePresetCard preset={basePreset} busy onInstall={jest.fn()} />
    )
    expect(screen.getByTestId("preset-install-acme/store:starter")).toBeDisabled()

    rerender(
      <PluginMarketplacePresetCard
        preset={{ ...basePreset, members: [] }}
        busy={false}
        onInstall={jest.fn()}
      />
    )
    expect(screen.getByTestId("preset-install-acme/store:starter")).toBeDisabled()
  })

  it("shows progress while its own run is in flight", () => {
    render(
      <PluginMarketplacePresetCard
        preset={basePreset}
        busy
        progress={{ completed: 1, total: 2 }}
        onInstall={jest.fn()}
      />
    )
    expect(screen.getByText(/presets\.installing/)).toBeInTheDocument()
    expect(screen.getByText(/"current":1,"total":2/)).toBeInTheDocument()
  })
})
