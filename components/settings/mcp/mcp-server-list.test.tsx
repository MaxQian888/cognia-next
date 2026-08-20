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
    tabIndex,
  }: {
    server: { id: string; name: string }
    density?: string
    active?: boolean
    toolCount?: number
    deniedToolCount?: number
    tabIndex?: number
  }) => (
    <div
      data-testid="row"
      data-server-id={server.id}
      data-density={density}
      data-active={String(Boolean(active))}
      data-tools={toolCount}
      data-denied={deniedToolCount}
      tabIndex={tabIndex}
    >
      {server.name}
    </div>
  ),
}))

import { fireEvent, render, screen } from "@testing-library/react"
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

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockReset()
})

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

  it("keeps exactly one tabstop, on the active row", () => {
    renderList({ activeId: "b" })
    const rows = screen.getAllByTestId("row")
    expect(rows[0]).toHaveAttribute("tabindex", "-1")
    expect(rows[1]).toHaveAttribute("tabindex", "0")
  })

  it("puts the tabstop on the first row when nothing is selected yet", () => {
    renderList()
    const rows = screen.getAllByTestId("row")
    expect(rows[0]).toHaveAttribute("tabindex", "0")
    expect(rows[1]).toHaveAttribute("tabindex", "-1")
  })

  it("moves selection with Down / Up, and selection follows focus", () => {
    renderList({ activeId: "a" })
    const rows = screen.getAllByTestId("row")
    fireEvent.keyDown(rows[0], { key: "ArrowDown" })
    expect(handlers.onOpen).toHaveBeenCalledWith("b")

    handlers.onOpen.mockClear()
    fireEvent.keyDown(rows[1], { key: "ArrowUp" })
    expect(handlers.onOpen).toHaveBeenCalledWith("a")
  })

  it("stops at the ends instead of wrapping", () => {
    renderList({ activeId: "a" })
    const rows = screen.getAllByTestId("row")
    fireEvent.keyDown(rows[0], { key: "ArrowUp" })
    expect(handlers.onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(rows[1], { key: "ArrowDown" })
    expect(handlers.onOpen).not.toHaveBeenCalled()
  })

  it("jumps to the ends with Home / End", () => {
    renderList({ activeId: "a" })
    const rows = screen.getAllByTestId("row")
    fireEvent.keyDown(rows[0], { key: "End" })
    expect(handlers.onOpen).toHaveBeenCalledWith("b")

    handlers.onOpen.mockClear()
    fireEvent.keyDown(rows[1], { key: "Home" })
    expect(handlers.onOpen).toHaveBeenCalledWith("a")
  })

  it("follows the rendered order across groups, not the group boundary", () => {
    // `bravo` is http and `alpha` is stdio, so transport grouping renders
    // stdio first — arrowing down from `alpha` must cross into the http group.
    renderList({ groupBy: "transport", activeId: "a" })
    fireEvent.keyDown(screen.getAllByTestId("row")[0], { key: "ArrowDown" })
    expect(handlers.onOpen).toHaveBeenCalledWith("b")
  })

  it("ignores keys it does not own", () => {
    renderList({ activeId: "a" })
    fireEvent.keyDown(screen.getAllByTestId("row")[0], { key: "ArrowRight" })
    expect(handlers.onOpen).not.toHaveBeenCalled()
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
