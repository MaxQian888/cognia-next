/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/hooks/mcp/use-mcp-server-logs", () => ({
  mcpServerLogsHref: (s: string) => `/logs?src=mcp&module=mcp:${s}`,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { McpServerRow } from "./mcp-server-row"
import type { McpServer } from "@cognia/agent-config-types"

const server: McpServer = {
  id: "mcp_1",
  name: "github",
  transport: "stdio",
  config: { command: "npx", args: ["-y", "server-github"] },
  enabled: true,
  appsEnabled: {},
  createdAt: 0,
  updatedAt: 0,
} as McpServer

const handlers = {
  onOpen: jest.fn(),
  onToggleSelect: jest.fn(),
  onToggleFavorite: jest.fn(),
  onToggle: jest.fn(),
  onEdit: jest.fn(),
  onClone: jest.fn(),
  onExport: jest.fn(),
  onDelete: jest.fn(),
}

function renderRow(overrides: Partial<React.ComponentProps<typeof McpServerRow>> = {}) {
  return render(
    <McpServerRow
      server={server}
      active={false}
      selected={false}
      favorite={false}
      density="comfortable"
      tabIndex={0}
      {...handlers}
      {...overrides}
    />
  )
}

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockReset()
})

describe("McpServerRow", () => {
  it("takes its tabstop from the caller's roving index", () => {
    renderRow({ tabIndex: -1 })
    expect(screen.getByTestId("mcp-server-row")).toHaveAttribute("tabindex", "-1")
  })

  it("exposes its id so the list's arrow handler can find it", () => {
    renderRow()
    expect(screen.getByTestId("mcp-server-row")).toHaveAttribute("data-server-id", "mcp_1")
  })

  it("opens the detail pane when the row is clicked", () => {
    renderRow()
    fireEvent.click(screen.getByTestId("mcp-server-row"))
    expect(handlers.onOpen).toHaveBeenCalledWith("mcp_1")
  })

  it("opens the detail pane from the keyboard", () => {
    renderRow()
    fireEvent.keyDown(screen.getByTestId("mcp-server-row"), { key: "Enter" })
    expect(handlers.onOpen).toHaveBeenCalledWith("mcp_1")
  })

  it("does not open the detail pane when the enable switch is used", () => {
    renderRow()
    fireEvent.click(screen.getByRole("switch"))
    expect(handlers.onToggle).toHaveBeenCalledWith(false)
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it("does not open the detail pane when the batch checkbox is used", () => {
    renderRow()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(handlers.onToggleSelect).toHaveBeenCalledWith("mcp_1")
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it("marks the active row for assistive tech", () => {
    renderRow({ active: true })
    expect(screen.getByTestId("mcp-server-row")).toHaveAttribute("aria-selected", "true")
  })

  it("prefers the display name over the SDK namespace", () => {
    renderRow({ server: { ...server, displayName: "GitHub" } as McpServer })
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.queryByText("github")).not.toBeInTheDocument()
  })

  it("shows the tool count, and flags how many are denied", () => {
    const { rerender } = renderRow({ toolCount: 12 })
    expect(screen.getByText(/toolsCount.*12/)).toBeInTheDocument()

    rerender(
      <McpServerRow
        server={server}
        active={false}
        selected={false}
        favorite={false}
        density="comfortable"
        tabIndex={0}
        toolCount={12}
        deniedToolCount={3}
        {...handlers}
      />
    )
    expect(screen.getByText(/toolsWithDenied/)).toBeInTheDocument()
  })

  it("hides the config summary in compact density", () => {
    renderRow({ density: "compact" })
    expect(screen.queryByText(/npx -y server-github/)).not.toBeInTheDocument()
  })

  it("shows the config summary in comfortable density", () => {
    renderRow()
    expect(screen.getByText("npx -y server-github")).toBeInTheDocument()
  })
})
