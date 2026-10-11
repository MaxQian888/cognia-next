/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, vars?: Record<string, unknown>) => {
    if (namespace === "plugins.categorySidebar") return `name(${key})`
    if (key === "capabilityChipLabel" && vars) return `${vars.name} · ${vars.count}`
    return vars ? `${key}:${JSON.stringify(vars)}` : key
  },
}))

import { PluginContributionChip } from "./plugin-contribution-chip"

describe("PluginContributionChip", () => {
  it("renders a plain badge, by name, when there is nothing to list", () => {
    render(<PluginContributionChip capability="themes" count={0} entries={[]} />)
    const chip = screen.getByText("name(capability.themes)")
    expect(chip).toHaveAttribute("title", "themes")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("names an uncurated capability through the catalog names", () => {
    render(<PluginContributionChip capability="theme-pack" count={5} entries={[]} />)
    expect(screen.getByText("name(capabilityName.theme-pack) · 5")).not.toHaveClass("font-mono")
  })

  it("prints an id the catalog does not know as stored, in the mono face", () => {
    render(<PluginContributionChip capability="from-a-newer-sdk" count={1} entries={[]} />)
    expect(screen.getByText("from-a-newer-sdk · 1")).toHaveClass("font-mono")
  })

  it("lists the contributions behind the chip on tap, with the capability id", async () => {
    const user = userEvent.setup()
    render(
      <PluginContributionChip
        capability="tools"
        count={2}
        entries={[{ id: "web_fetch", label: "Fetch a page" }, { id: "web_search" }]}
      />
    )
    const trigger = screen.getByRole("button", {
      name: 'capabilityChipAria:{"capability":"name(capability.tools)","count":2}',
    })
    expect(trigger).toHaveTextContent("name(capability.tools) · 2")
    await user.click(trigger)
    expect(await screen.findByText("web_fetch")).toBeInTheDocument()
    expect(screen.getByText("Fetch a page")).toBeInTheDocument()
    expect(screen.getByText("web_search")).toBeInTheDocument()
    expect(screen.getByText("tools")).toBeInTheDocument()
  })
})
