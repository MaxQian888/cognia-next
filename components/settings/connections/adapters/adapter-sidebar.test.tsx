/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

// Stub the row so the sidebar test stays focused on search / filter / stats /
// pass-through and doesn't need the row's deep dependency tree.
jest.mock("./adapter-list-row", () => ({
  AdapterListRow: ({
    row,
    pendingCount,
  }: {
    row: { id: string; displayName: string }
    pendingCount: number
  }) => (
    <li data-testid={`row-${row.id}`} data-pending={pendingCount}>
      {row.displayName}
    </li>
  ),
}))

import { AdapterSidebar } from "./adapter-sidebar"

const baseRow: AdapterInstanceRow = {
  id: "tg-1",
  type: "telegram",
  displayName: "Telegram Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
  trigger: defaultPrivateChatPolicy(),
  defaultMode: "auto",
  mediaModelPolicy: "local_extract_only",
  createdAt: 1,
  updatedAt: 1,
}
const disabledRow: AdapterInstanceRow = {
  ...baseRow,
  id: "dc-1",
  displayName: "Discord",
  enabled: false,
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof AdapterSidebar>> = {}) {
  const onSearchChange = jest.fn()
  const onStatusFilterChange = jest.fn()
  const onConfigure = jest.fn()
  render(
    <AdapterSidebar
      adapters={[baseRow, disabledRow]}
      pendingByAdapter={new Map([["tg-1", 3]])}
      onConfigure={onConfigure}
      searchQuery=""
      onSearchChange={onSearchChange}
      statusFilter="all"
      onStatusFilterChange={onStatusFilterChange}
      addButton={<button>Add adapter</button>}
      {...overrides}
    />
  )
  return { onSearchChange, onStatusFilterChange, onConfigure }
}

describe("AdapterSidebar", () => {
  it("renders the search box and add button", () => {
    renderSidebar()
    expect(screen.getByTestId("adapter-sidebar-search")).toBeInTheDocument()
    expect(screen.getByText("Add adapter")).toBeInTheDocument()
  })

  it("renders the three status filter tabs", () => {
    renderSidebar()
    expect(screen.getByRole("tab", { name: /all/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /^enabled$/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /^disabled$/i })).toBeInTheDocument()
  })

  it("renders one row per adapter and forwards the pending count", () => {
    renderSidebar()
    expect(screen.getByTestId("row-tg-1")).toHaveAttribute("data-pending", "3")
    expect(screen.getByTestId("row-dc-1")).toHaveAttribute("data-pending", "0")
  })

  it("shows total and enabled counts in the stats footer", () => {
    renderSidebar()
    // 2 connectors, 1 enabled.
    expect(screen.getByText(/2 connectors · 1 enabled/i)).toBeInTheDocument()
  })

  it("calls onSearchChange when typing in the search box", () => {
    const { onSearchChange } = renderSidebar()
    fireEvent.change(screen.getByTestId("adapter-sidebar-search"), { target: { value: "lark" } })
    expect(onSearchChange).toHaveBeenCalledWith("lark")
  })

  it("calls onStatusFilterChange when a filter tab is clicked", async () => {
    const { onStatusFilterChange } = renderSidebar()
    await userEvent.click(screen.getByRole("tab", { name: /^enabled$/i }))
    expect(onStatusFilterChange).toHaveBeenCalledWith("enabled")
  })
})
