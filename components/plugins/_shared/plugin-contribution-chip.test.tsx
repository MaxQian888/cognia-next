/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { PluginContributionChip } from "./plugin-contribution-chip"

describe("PluginContributionChip", () => {
  it("renders a plain badge when there is nothing to list", () => {
    render(<PluginContributionChip capability="themes" count={0} entries={[]} />)
    expect(screen.getByText("themes")).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("lists the contributions behind the chip on tap", async () => {
    const user = userEvent.setup()
    render(
      <PluginContributionChip
        capability="tools"
        count={2}
        entries={[{ id: "web_fetch", label: "Fetch a page" }, { id: "web_search" }]}
      />
    )
    const trigger = screen.getByRole("button", {
      name: 'capabilityChipAria:{"capability":"tools","count":2}',
    })
    expect(trigger).toHaveTextContent("tools · 2")
    await user.click(trigger)
    expect(await screen.findByText("web_fetch")).toBeInTheDocument()
    expect(screen.getByText("Fetch a page")).toBeInTheDocument()
    expect(screen.getByText("web_search")).toBeInTheDocument()
  })
})
