/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { McpFilterSheet } from "./mcp-filter-sheet"

beforeEach(() => {
  useMcpPanelStore.setState({
    filterSheetOpen: true,
    search: "",
    transportFilter: "all",
    statusFilter: "all",
    trustFilter: "all",
  })
})

describe("McpFilterSheet", () => {
  it("renders the localized title, description and axis labels when open", () => {
    render(<McpFilterSheet />)
    expect(screen.getByText("view.filters")).toBeInTheDocument()
    expect(screen.getByText("filter.description")).toBeInTheDocument()
    expect(screen.getByText("filter.transport")).toBeInTheDocument()
    expect(screen.getByText("filter.status")).toBeInTheDocument()
    expect(screen.getByText("filter.trust")).toBeInTheDocument()
  })

  it("renders nothing visible when the sheet is closed", () => {
    useMcpPanelStore.setState({ filterSheetOpen: false })
    render(<McpFilterSheet />)
    expect(screen.queryByText("filter.transport")).not.toBeInTheDocument()
  })

  it("resets every filter axis via the footer clear button", () => {
    useMcpPanelStore.setState({
      transportFilter: "http",
      statusFilter: "disabled",
      trustFilter: "pending",
      search: "git",
    })
    render(<McpFilterSheet />)
    fireEvent.click(screen.getByText("list.clearFilters"))
    const { transportFilter, statusFilter, trustFilter, search } = useMcpPanelStore.getState()
    expect(transportFilter).toBe("all")
    expect(statusFilter).toBe("all")
    expect(trustFilter).toBe("all")
    expect(search).toBe("")
  })

  it("closing the sheet via onOpenChange flips the store flag", () => {
    render(<McpFilterSheet />)
    // Radix Sheet renders a close button labelled "Close" by default.
    fireEvent.click(screen.getByText("Close"))
    expect(useMcpPanelStore.getState().filterSheetOpen).toBe(false)
  })
})
