/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { usePluginsStore } from "@/stores/plugins"
import { PLUGIN_GOVERNANCE_VIEWS } from "../plugin-nav-config"
import { PluginGovernanceHeader } from "./plugin-governance-header"

beforeEach(() => {
  usePluginsStore.setState({ governanceView: "permissions" })
})

describe("PluginGovernanceHeader", () => {
  it("renders one segment per governance view", () => {
    render(<PluginGovernanceHeader />)
    for (const view of PLUGIN_GOVERNANCE_VIEWS) {
      expect(screen.getByTestId(`plugin-governance-view-${view.value}`)).toBeInTheDocument()
    }
  })

  it("keeps every view visible — views are not countable, so none is ever dropped", () => {
    // The zero-count rule only applies to segments carrying a numeric count.
    // Governance views carry none, so all five must survive regardless of
    // whether the underlying aggregate has any rows.
    render(<PluginGovernanceHeader />)
    expect(screen.getAllByTestId(/^plugin-governance-view-/)).toHaveLength(
      PLUGIN_GOVERNANCE_VIEWS.length
    )
  })

  it("marks the store's active view as pressed", () => {
    usePluginsStore.setState({ governanceView: "analytics" })
    render(<PluginGovernanceHeader />)
    expect(screen.getByTestId("plugin-governance-view-analytics")).toHaveAttribute(
      "data-state",
      "on"
    )
    expect(screen.getByTestId("plugin-governance-view-audit")).toHaveAttribute("data-state", "off")
  })

  it("writes the picked view back to the store", () => {
    render(<PluginGovernanceHeader />)
    fireEvent.click(screen.getByTestId("plugin-governance-view-policy"))
    expect(usePluginsStore.getState().governanceView).toBe("policy")
  })

  it("does not render a search box — governance aggregates are not searched here", () => {
    render(<PluginGovernanceHeader />)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })
})
