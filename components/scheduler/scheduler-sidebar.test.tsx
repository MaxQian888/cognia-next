/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub the Sidebar primitives so we don't need a Provider / matchMedia.
jest.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
}))

jest.mock("./unified-task-sidebar-item", () => ({
  __esModule: true,
  UnifiedTaskSidebarItem: ({
    item,
    isActive,
    isHighlighted,
    onClick,
  }: {
    item: { unifiedId: string; name: string }
    isActive?: boolean
    isHighlighted?: boolean
    onClick: (i: unknown) => void
  }) => (
    <button
      data-testid={`unified-${item.unifiedId}`}
      data-active={isActive || undefined}
      data-highlighted={isHighlighted || undefined}
      onClick={() => onClick(item)}
    >
      {item.name}
    </button>
  ),
}))

jest.mock("./scheduler-filter-bar", () => ({
  __esModule: true,
  SchedulerFilterBar: ({
    statusCounts,
    countsByKind,
    loopCount,
    onStatusChange,
    onToggleKind,
    onLoopOnlyChange,
    onClearKindFilters,
  }: {
    statusCounts: Record<string, number>
    countsByKind: Record<string, number>
    loopCount: number
    onStatusChange: (s: string) => void
    onToggleKind: (k: string) => void
    onLoopOnlyChange: (v: boolean) => void
    onClearKindFilters: () => void
  }) => (
    <div data-testid="filter-bar">
      <span data-testid="fb-status-all">{statusCounts.all}</span>
      <span data-testid="fb-status-active">{statusCounts.active}</span>
      <span data-testid="fb-kind-workflow">{countsByKind.workflow}</span>
      <span data-testid="fb-loop-count">{loopCount}</span>
      <button data-testid="fb-set-active" onClick={() => onStatusChange("active")} />
      <button data-testid="fb-toggle-workflow" onClick={() => onToggleKind("workflow")} />
      <button data-testid="fb-loop-on" onClick={() => onLoopOnlyChange(true)} />
      <button data-testid="fb-clear" onClick={onClearKindFilters} />
    </div>
  ),
}))

jest.mock("./empty-states", () => ({
  __esModule: true,
  TaskListEmptyState: ({
    onCreate,
    onClearFilters,
    variant,
  }: {
    onCreate?: () => void
    onClearFilters?: () => void
    variant?: string
  }) => (
    <div data-testid={`empty-state-${variant ?? "default"}`}>
      {onCreate && (
        <button onClick={onCreate} data-testid="empty-create">
          create
        </button>
      )}
      {onClearFilters && (
        <button onClick={onClearFilters} data-testid="empty-clear">
          clear
        </button>
      )}
    </div>
  ),
}))

import { SchedulerSidebar } from "./scheduler-sidebar"
import { deriveUnifiedFacets } from "@/lib/scheduler/unified-filter"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"

function buildUnified(
  kind: ScheduledItemKind,
  sourceId: string,
  overrides: Partial<UnifiedScheduledItem> = {}
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name: `${kind} ${sourceId}`,
    status: "active",
    triggerSummary: { type: "interval", intervalMs: 60_000 },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  } as UnifiedScheduledItem
}

const ITEMS = [
  buildUnified("app", "1"),
  buildUnified("workflow", "2", { status: "paused" }),
  buildUnified("backup", "3", { status: "paused", tags: ["loop"] }),
]

function setup(overrides: Partial<React.ComponentProps<typeof SchedulerSidebar>> = {}) {
  const items = (overrides.items ?? ITEMS) as UnifiedScheduledItem[]
  const criteria = {
    search: overrides.searchQuery,
    status: overrides.statusFilter,
    kinds: overrides.selectedKinds,
    loopOnly: overrides.loopOnly,
  }
  const props: React.ComponentProps<typeof SchedulerSidebar> = {
    items,
    facets: deriveUnifiedFacets(items, criteria),
    selectedUnifiedId: null,
    schedulerStatus: "running",
    searchQuery: "",
    onSearchChange: jest.fn(),
    statusFilter: "all",
    onStatusFilterChange: jest.fn(),
    selectedKinds: new Set(),
    onToggleKind: jest.fn(),
    loopOnly: false,
    onLoopOnlyChange: jest.fn(),
    onClearKindFilters: jest.fn(),
    onResetFilters: jest.fn(),
    onSelectItem: jest.fn(),
    ...overrides,
  }
  return { props, ...render(<SchedulerSidebar {...props} />) }
}

describe("SchedulerSidebar", () => {
  it("renders the unified rows grouped by kind", () => {
    setup()
    expect(screen.getByTestId("unified-app:1")).toBeInTheDocument()
    expect(screen.getByTestId("unified-workflow:2")).toBeInTheDocument()
    expect(screen.getByTestId("unified-backup:3")).toBeInTheDocument()
  })

  it("renders only the rows that survive the filter — the list the counts describe", () => {
    setup({ statusFilter: "paused" })
    expect(screen.queryByTestId("unified-app:1")).not.toBeInTheDocument()
    expect(screen.getByTestId("unified-workflow:2")).toBeInTheDocument()
    expect(screen.getByTestId("unified-backup:3")).toBeInTheDocument()
  })

  it("narrows the visible rows by the search query", () => {
    setup({ searchQuery: "workflow" })
    expect(screen.getByTestId("unified-workflow:2")).toBeInTheDocument()
    expect(screen.queryByTestId("unified-app:1")).not.toBeInTheDocument()
  })

  it("narrows the visible rows by the pinned kinds", () => {
    setup({ selectedKinds: new Set<ScheduledItemKind>(["backup"]) })
    expect(screen.getByTestId("unified-backup:3")).toBeInTheDocument()
    expect(screen.queryByTestId("unified-app:1")).not.toBeInTheDocument()
  })

  it("narrows the visible rows to /loop tasks", () => {
    setup({ loopOnly: true })
    expect(screen.getByTestId("unified-backup:3")).toBeInTheDocument()
    expect(screen.queryByTestId("unified-workflow:2")).not.toBeInTheDocument()
  })

  it("feeds the filter row facet counts derived from the same list", () => {
    setup()
    expect(screen.getByTestId("fb-status-all")).toHaveTextContent("3")
    expect(screen.getByTestId("fb-status-active")).toHaveTextContent("1")
    expect(screen.getByTestId("fb-kind-workflow")).toHaveTextContent("1")
    expect(screen.getByTestId("fb-loop-count")).toHaveTextContent("1")
  })

  it("forwards each filter control to the page", () => {
    const { props } = setup()
    fireEvent.click(screen.getByTestId("fb-set-active"))
    expect(props.onStatusFilterChange).toHaveBeenCalledWith("active")
    fireEvent.click(screen.getByTestId("fb-toggle-workflow"))
    expect(props.onToggleKind).toHaveBeenCalledWith("workflow")
    fireEvent.click(screen.getByTestId("fb-loop-on"))
    expect(props.onLoopOnlyChange).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByTestId("fb-clear"))
    expect(props.onClearKindFilters).toHaveBeenCalled()
  })

  it("calls onSearchChange when typing in the search input", () => {
    const onSearchChange = jest.fn()
    setup({ onSearchChange })
    fireEvent.change(screen.getByPlaceholderText("searchTasks"), { target: { value: "abc" } })
    expect(onSearchChange).toHaveBeenCalledWith("abc")
  })

  it("clears the search query via the X button", () => {
    const onSearchChange = jest.fn()
    setup({ searchQuery: "abc", onSearchChange })
    fireEvent.click(screen.getByLabelText("clearSearch"))
    expect(onSearchChange).toHaveBeenCalledWith("")
  })

  it("dispatches onSelectItem with the whole item, whatever its kind", () => {
    const onSelectItem = jest.fn()
    setup({ onSelectItem })
    fireEvent.click(screen.getByTestId("unified-workflow:2"))
    expect(onSelectItem).toHaveBeenCalledWith(expect.objectContaining({ unifiedId: "workflow:2" }))
  })

  it("marks the selected and keyboard-highlighted rows by unifiedId", () => {
    setup({ selectedUnifiedId: "app:1", highlightedUnifiedId: "workflow:2" })
    expect(screen.getByTestId("unified-app:1")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("unified-workflow:2")).toHaveAttribute("data-highlighted", "true")
  })

  it("renders the status dot with the right class for each scheduler status", () => {
    const { rerender, props } = setup({ schedulerStatus: "running" })
    expect(screen.getByTestId("scheduler-status-dot").className).toMatch(/bg-green-500/)
    rerender(<SchedulerSidebar {...props} schedulerStatus="stopped" />)
    expect(screen.getByTestId("scheduler-status-dot").className).toMatch(/bg-red-500/)
    rerender(<SchedulerSidebar {...props} schedulerStatus="idle" />)
    expect(screen.getByTestId("scheduler-status-dot").className).toMatch(/bg-gray-400/)
  })

  it("labels whether the task list belongs to the local or remote host", () => {
    const { rerender, props } = setup({ schedulerHost: "local" })
    expect(screen.getByTestId("scheduler-host")).toHaveTextContent("host.local")
    rerender(<SchedulerSidebar {...props} schedulerHost="remote" />)
    expect(screen.getByTestId("scheduler-host")).toHaveTextContent("host.remote")
  })

  it("renders the create empty state when no source has any item", () => {
    setup({ items: [] })
    expect(screen.getByTestId("empty-state-default")).toBeInTheDocument()
  })

  it("renders the filtered empty state, wired to a full reset", () => {
    const onResetFilters = jest.fn()
    setup({ selectedKinds: new Set<ScheduledItemKind>(["system"]), onResetFilters })
    expect(screen.getByTestId("empty-state-filtered")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("empty-clear"))
    expect(onResetFilters).toHaveBeenCalled()
  })

  it("reports the total in the footer when nothing is filtered out", () => {
    setup()
    expect(screen.getByTestId("scheduler-sidebar-count")).toHaveTextContent("sidebarFooter.total")
    expect(screen.queryByTestId("scheduler-sidebar-reset-filters")).not.toBeInTheDocument()
  })

  it("says how much the filter is hiding, and offers a reset", () => {
    const onResetFilters = jest.fn()
    setup({ statusFilter: "active", onResetFilters })
    expect(screen.getByTestId("scheduler-sidebar-count")).toHaveTextContent(
      "sidebarFooter.filtered"
    )
    fireEvent.click(screen.getByTestId("scheduler-sidebar-reset-filters"))
    expect(onResetFilters).toHaveBeenCalled()
  })
})
