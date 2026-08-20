/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("./mcp-server-row", () => ({
  McpServerRow: ({
    server,
    density,
    active,
    toolCount,
    deniedToolCount,
  }: {
    server: { name: string }
    density?: string
    active?: boolean
    toolCount?: number
    deniedToolCount?: number
  }) => (
    <div
      data-testid="row"
      data-density={density}
      data-active={String(Boolean(active))}
      data-tools={toolCount}
      data-denied={deniedToolCount}
    >
      {server.name}
    </div>
  ),
}))

import { render, screen } from "@testing-library/react"
import { McpServerList } from "./mcp-server-list"
import type { McpServer } from "@cognia/agent-config-types"

const servers: McpServer[] = [
  {
    id: "a",
    name: "alpha",
    transport: "stdio",
    config: {},
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
  } as McpServer,
  {
    id: "b",
    name: "bravo",
    transport: "http",
    config: {},
    enabled: false,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
  } as McpServer,
]

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

function renderList(overrides: Partial<React.ComponentProps<typeof McpServerList>> = {}) {
  return render(
    <McpServerList
      servers={servers}
      density="comfortable"
      groupBy="none"
      selection={new Set()}
      activeId={null}
      isFavorite={() => false}
      toolCounts={new Map()}
      deniedToolCounts={new Map()}
      {...handlers}
      {...overrides}
    />
  )
}

describe("McpServerList", () => {
  it("renders one row per server with no group header in 'none' mode", () => {
    renderList()
    expect(screen.getAllByTestId("row")).toHaveLength(2)
    expect(screen.getAllByTestId("row")[0]).toHaveAttribute("data-density", "comfortable")
  })

  it("renders transport group headers", () => {
    renderList({ groupBy: "transport", density: "compact" })
    expect(screen.getByText("stdio")).toBeInTheDocument()
    expect(screen.getByText("http")).toBeInTheDocument()
    expect(screen.getAllByTestId("row")[0]).toHaveAttribute("data-density", "compact")
  })

  it("renders status group headers via i18n keys", () => {
    renderList({ groupBy: "status" })
    expect(screen.getByText("enabled")).toBeInTheDocument()
    expect(screen.getByText("disabled")).toBeInTheDocument()
  })

  it("marks only the active row", () => {
    renderList({ activeId: "b" })
    const rows = screen.getAllByTestId("row")
    expect(rows[0]).toHaveAttribute("data-active", "false")
    expect(rows[1]).toHaveAttribute("data-active", "true")
  })

  it("passes each server its own tool counts", () => {
    renderList({
      toolCounts: new Map([["a", 7]]),
      deniedToolCounts: new Map([["a", 2]]),
    })
    const rows = screen.getAllByTestId("row")
    expect(rows[0]).toHaveAttribute("data-tools", "7")
    expect(rows[0]).toHaveAttribute("data-denied", "2")
    // `bravo` was never probed: no count rather than a misleading zero.
    expect(rows[1]).not.toHaveAttribute("data-tools")
  })
})
