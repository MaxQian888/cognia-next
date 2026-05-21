/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginDetailTabs } from "./plugin-detail-tabs"

const TABS = ["overview", "capabilities", "configure", "permissions", "data"] as const

describe("PluginDetailTabs", () => {
  beforeEach(() => {
    usePluginsStore.setState({ detailSubTab: "overview" })
  })

  it("renders all 5 sub-tab triggers", () => {
    render(<PluginDetailTabs />)
    for (const value of TABS) {
      expect(screen.getByTestId(`plugin-detail-subtab-${value}`)).toBeInTheDocument()
    }
  })

  it("marks the active tab via aria-selected based on the store", () => {
    usePluginsStore.setState({ detailSubTab: "permissions" })
    render(<PluginDetailTabs />)
    expect(
      screen.getByTestId("plugin-detail-subtab-permissions").getAttribute("aria-selected")
    ).toBe("true")
    expect(screen.getByTestId("plugin-detail-subtab-overview").getAttribute("aria-selected")).toBe(
      "false"
    )
  })

  it("clicking a tab updates the store", () => {
    render(<PluginDetailTabs />)
    fireEvent.click(screen.getByTestId("plugin-detail-subtab-data"))
    expect(usePluginsStore.getState().detailSubTab).toBe("data")
  })
})
