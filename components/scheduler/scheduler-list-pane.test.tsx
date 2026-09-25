import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => (
    <aside data-testid="sidebar-chrome">{children}</aside>
  ),
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
}))

jest.mock("./scheduler-filter-bar", () => ({
  __esModule: true,
  SchedulerFilterBar: ({
    status,
    onStatusChange,
  }: {
    status: string
    onStatusChange: (s: string) => void
  }) => (
    <button
      data-testid="filter-bar"
      data-status={status}
      onClick={() => onStatusChange("paused")}
    />
  ),
}))

import {
  SchedulerListPane,
  SchedulerListSidebar,
  type SchedulerListPaneProps,
} from "./scheduler-list-pane"
import type { SchedulerListFilterState } from "@/hooks/scheduler/use-scheduler-list-filter"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(name: string): UnifiedScheduledItem {
  return {
    unifiedId: `app:${name}`,
    kind: "app",
    sourceId: name,
    name,
    status: "active",
    triggerSummary: { type: "cron", cron: "* * * * *" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

function filterState(over: Partial<SchedulerListFilterState> = {}): SchedulerListFilterState {
  return {
    filter: { search: "", status: "all", kinds: [], loopOnly: false },
    kinds: new Set(),
    facets: {
      visibleItems: [],
      statusCounts: { all: 0, active: 0, paused: 0, loop: 0 },
      countsByKind: { app: 0, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 },
      loopCount: 0,
    },
    isFiltering: false,
    setSearch: jest.fn(),
    setStatus: jest.fn(),
    toggleKind: jest.fn(),
    setLoopOnly: jest.fn(),
    clearKindFilters: jest.fn(),
    reset: jest.fn(),
    ...over,
  }
}

function props(over: Partial<SchedulerListPaneProps> = {}): SchedulerListPaneProps {
  return {
    items: [item("a"), item("b")],
    totalCount: 2,
    filter: filterState(),
    signalByItem: new Map(),
    sourceErrors: {},
    selectedId: "app:a",
    checkedIds: [],
    onSelect: jest.fn(),
    onToggleCheck: jest.fn(),
    onCheckAll: jest.fn(),
    onClearChecks: jest.fn(),
    onCreate: jest.fn(),
    ...over,
  }
}

describe("SchedulerListPane", () => {
  it("renders search, the filter bar, the rows and the total", () => {
    const p = props()
    render(<SchedulerListPane {...p} />)
    fireEvent.change(screen.getByTestId("scheduler-search"), { target: { value: "night" } })
    expect(p.filter.setSearch).toHaveBeenCalledWith("night")
    fireEvent.click(screen.getByTestId("filter-bar"))
    expect(p.filter.setStatus).toHaveBeenCalledWith("paused")
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByTestId("scheduler-list-row-app:a").dataset.selected).toBe("true")
    expect(screen.getByTestId("scheduler-list-count")).toHaveTextContent("2 items")
    expect(screen.queryByTestId("scheduler-check-strip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-source-errors")).not.toBeInTheDocument()
  })

  it("shows the check strip while anything is checked and can check every visible row", () => {
    const p = props({ checkedIds: ["app:a"] })
    render(<SchedulerListPane {...p} />)
    expect(screen.getByTestId("scheduler-check-strip")).toHaveTextContent("1 selected")
    fireEvent.click(screen.getByTestId("scheduler-check-all"))
    expect(p.onCheckAll).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("scheduler-check-clear"))
    expect(p.onClearChecks).toHaveBeenCalled()
  })

  it("names the sources that failed and says how much a filter hides", () => {
    const p = props({
      items: [item("a")],
      totalCount: 5,
      sourceErrors: { backup: new Error("x"), plugin: undefined },
      filter: filterState({ isFiltering: true }),
    })
    render(<SchedulerListPane {...p} />)
    expect(screen.getByTestId("scheduler-source-errors")).toHaveTextContent("Backup")
    expect(screen.getByTestId("scheduler-source-errors")).not.toHaveTextContent("Plugin")
    expect(screen.getByTestId("scheduler-list-count")).toHaveTextContent("1 of 5 shown")
    fireEvent.click(screen.getByTestId("scheduler-list-reset-filters"))
    expect(p.filter.reset).toHaveBeenCalled()
  })

  it("distinguishes an empty schedule from an empty filter", () => {
    const p = props({ items: [], totalCount: 0 })
    const { rerender } = render(<SchedulerListPane {...p} />)
    expect(screen.getByText("No scheduled tasks yet")).toBeInTheDocument()
    rerender(
      <SchedulerListPane
        {...props({ items: [], totalCount: 3, filter: filterState({ isFiltering: true }) })}
      />
    )
    expect(screen.getByText("No matching tasks")).toBeInTheDocument()
  })

  it("mounts the bulk toolbar inside the pane and wraps in chrome for the sidebar variant", () => {
    render(<SchedulerListSidebar {...props({ bulkToolbar: <div data-testid="bulk" /> })} />)
    expect(screen.getByTestId("sidebar-chrome")).toContainElement(screen.getByTestId("bulk"))
  })
})

it("disambiguates same-name tasks without renaming persisted names", () => {
  const first = { ...item("first"), name: "demo-heartbeat" }
  const second = { ...item("second"), name: "demo-heartbeat" }
  render(<SchedulerListPane {...props({ items: [first, second] })} />)
  expect(screen.getAllByText("demo-heartbeat")).toHaveLength(2)
  expect(screen.getByTitle("app:first")).toHaveTextContent("first")
  expect(screen.getByTitle("app:second")).toHaveTextContent("second")
})

describe("SchedulerListPane · a row that was just added", () => {
  it("rings the new row and brings it into view", () => {
    const scrollIntoView = jest.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    try {
      const rows = [item("Alpha"), item("Beta")]
      render(<SchedulerListPane {...props({ items: rows, justCreatedId: rows[1].unifiedId })} />)
      const ringed = document.querySelector('[data-just-created="true"]')
      expect(ringed).toHaveAttribute("data-item-id", rows[1].unifiedId)
      expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "nearest" }))
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it("rings nothing when nothing was just added", () => {
    render(<SchedulerListPane {...props({ items: [item("Alpha")] })} />)
    expect(document.querySelector("[data-just-created]")).toBeNull()
  })
})
