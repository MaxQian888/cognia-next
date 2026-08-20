/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { McpPanelTabs } from "./mcp-panel-tabs"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"

beforeEach(() => {
  useMcpPanelStore.setState({ activeTab: "my-servers" })
})

describe("McpPanelTabs", () => {
  it("renders one trigger per tab", () => {
    render(<McpPanelTabs />)
    expect(screen.getAllByRole("tab")).toHaveLength(4)
  })

  it("marks the store's active tab as selected", () => {
    useMcpPanelStore.setState({ activeTab: "health" })
    render(<McpPanelTabs />)
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("health")
  })

  it("writes the picked tab back to the store", async () => {
    render(<McpPanelTabs />)
    // Radix selects on mousedown/focus, not click.
    await userEvent.setup().click(screen.getByText("presets"))
    expect(useMcpPanelStore.getState().activeTab).toBe("presets")
  })
})
