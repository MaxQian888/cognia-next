/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderSidebar } from "./provider-sidebar"

/** Both filter axes live behind one trigger now, so every pick is two clicks. */
async function pickStatus(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(screen.getByTestId("provider-filter-trigger"))
  await user.click(screen.getByTestId(`provider-filter-status-${value}`))
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      "sidebar.searchPlaceholder": "Search providers...",
      "sidebar.addButton": "Add",
      "sidebar.modelCompare": "Model Compare",
      "sidebar.statusLabel": "Filter by status",
      "sidebar.filterLabel": "Filters",
      "sidebar.categoryLabel": "Category",
      "sidebar.removeFilter": "Remove filter",
      "sidebar.statusAll": "All status",
      "sidebar.statusConnected": "Connected",
      "sidebar.statusWarning": "Warning",
      "sidebar.statusLimited": "Limited",
      "sidebar.statusUntested": "Not tested",
      "sidebar.statusUnconfigured": "Unconfigured",
      "sidebar.statusError": "Error",
      "sidebar.noMatches": "No providers match these filters.",
      "sidebar.clearFilters": "Clear filters",
      "categories.all": "All",
      "categories.flagship": "Flagship",
      "categories.enterprise": "Enterprise",
      "categories.specialized": "Specialized",
      "categories.aggregator": "Aggregators",
      "categories.local": "Local",
      "categories.custom": "Custom",
      "sidebar.sortLabel": "Sort providers",
      "sidebar.sortName": "Name",
      "sidebar.sortStatus": "Status",
      "sidebar.sortLastUsed": "Recently used",
    }
    if (key === "sidebar.stats") {
      return `${params?.filtered} shown of ${params?.total} · ${params?.active} connected`
    }
    return map[key] ?? key
  },
}))

const mockProviders = [
  { id: "openai", name: "OpenAI", icon: "🤖", subtitle: "GPT-4o", status: "connected" as const },
  {
    id: "anthropic",
    name: "Anthropic",
    icon: "🧠",
    subtitle: "Claude 3.5",
    status: "connected" as const,
  },
  {
    id: "google",
    name: "Google",
    icon: "🔍",
    subtitle: "Not configured",
    status: "not-configured" as const,
  },
]

/**
 * The status filter is controlled by the parent (persisted preference; one
 * value shared by the desktop column and the mobile sheet). This wrapper
 * plays the parent so click-through tests still see the list narrow.
 */
function ControlledSidebar(
  props: Omit<React.ComponentProps<typeof ProviderSidebar>, "statusFilter"> & {
    initialStatusFilter?: React.ComponentProps<typeof ProviderSidebar>["statusFilter"]
  }
) {
  const { initialStatusFilter = "all", onStatusFilterChange, ...rest } = props
  const [statusFilter, setStatusFilter] = React.useState(initialStatusFilter)
  return (
    <ProviderSidebar
      {...rest}
      statusFilter={statusFilter}
      onStatusFilterChange={(next) => {
        setStatusFilter(next)
        onStatusFilterChange?.(next)
      }}
    />
  )
}

describe("ProviderSidebar", () => {
  const defaultProps = {
    providers: mockProviders,
    selectedId: null as string | null,
    onSelect: jest.fn(),
    onCompareClick: jest.fn(),
    categoryFilter: "all" as string,
    onCategoryChange: jest.fn(),
    statusFilter: "all" as const,
    onStatusFilterChange: jest.fn(),
    searchQuery: "",
    onSearchChange: jest.fn(),
    addButton: <button>Add</button>,
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders all providers in the list", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("Google")).toBeInTheDocument()
  })

  it("moves focus and selection through the provider list with arrow keys", () => {
    render(<ProviderSidebar {...defaultProps} />)
    const options = screen.getAllByRole("option")
    options[0].focus()
    fireEvent.keyDown(options[0], { key: "ArrowDown" })
    expect(options[1]).toHaveFocus()
    expect(defaultProps.onSelect).toHaveBeenCalledWith("anthropic")
  })

  it("shows correct stats", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByText("3 shown of 3 · 2 connected")).toBeInTheDocument()
  })

  it("renders search input", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByPlaceholderText("Search providers...")).toBeInTheDocument()
  })

  it("renders Model Compare button", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByText("Model Compare")).toBeInTheDocument()
  })

  it("offers every catalog category inside the filter popover", async () => {
    const user = userEvent.setup()
    render(<ProviderSidebar {...defaultProps} />)
    await user.click(screen.getByTestId("provider-filter-trigger"))
    for (const key of [
      "all",
      "flagship",
      "enterprise",
      "specialized",
      "aggregator",
      "local",
      "custom",
    ]) {
      // Enterprise used to be folded into the Flagship tab, so its label named
      // one thing and its contents were two.
      expect(screen.getByTestId(`provider-filter-category-${key}`)).toBeInTheDocument()
    }
    // The retired strip's "Voice" (= specialized) / "Vision" tabs are gone.
    expect(screen.queryByTestId("provider-filter-category-voice")).not.toBeInTheDocument()
  })

  it("offers a sort menu wired to the persisted preference", async () => {
    const onSortByChange = jest.fn()
    render(<ProviderSidebar {...defaultProps} sortBy="name" onSortByChange={onSortByChange} />)
    const trigger = screen.getByTestId("provider-sort-trigger")
    // Radix opens the menu on a primary-button pointerdown; keyboard works too.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" })
    const statusItem = await screen.findByTestId("provider-sort-status")
    fireEvent.click(statusItem)
    expect(onSortByChange).toHaveBeenCalledWith("status")
  })

  it("hides the sort menu when no handler is supplied", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.queryByTestId("provider-sort-trigger")).not.toBeInTheDocument()
  })

  // The two filter axes used to be `flex-wrap` chip bands above the list: six
  // category tabs and seven status buttons. On a 320px rail that was four rows
  // of chrome, and once the rail started giving up width to the detail column
  // it became seven, taller than the list it filtered.
  it("spends one row on filters, not two wrapping bands", () => {
    const { container } = render(<ProviderSidebar {...defaultProps} />)
    expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull()
    expect(screen.getByTestId("provider-filter-trigger")).toBeInTheDocument()
    // Nothing is on screen for either axis until the popover is opened.
    expect(screen.queryByTestId("provider-filter-category-flagship")).not.toBeInTheDocument()
    expect(screen.queryByTestId("provider-filter-status-connected")).not.toBeInTheDocument()
  })

  it("counts the active filters on the trigger and undoes each from its chip", async () => {
    const onCategoryChange = jest.fn()
    const user = userEvent.setup()
    render(
      <ProviderSidebar
        {...defaultProps}
        categoryFilter="flagship"
        onCategoryChange={onCategoryChange}
        statusFilter="connected"
      />
    )
    expect(screen.getByTestId("provider-filter-count")).toHaveTextContent("2")
    await user.click(screen.getByTestId("provider-filter-chip-category"))
    expect(onCategoryChange).toHaveBeenCalledWith("all")
  })

  it("keeps the provider rows inside the rail width", () => {
    // Radix wraps the scroll viewport's children in a `display:table` div that
    // sizes to content, which let a wide row push the list past the rail edge.
    const { container } = render(<ProviderSidebar {...defaultProps} />)
    expect(container.querySelector('[data-slot="scroll-area"]')).toHaveClass(
      "[&_[data-slot=scroll-area-viewport]>div]:!block"
    )
  })

  describe("empty list", () => {
    it("keeps the search box and category tabs when nothing matches", () => {
      // The whole sidebar used to be replaced by the empty state, taking these
      // controls with it — so picking a category with no matches left no way
      // to undo the filter.
      render(<ProviderSidebar {...defaultProps} providers={[]} categoryFilter="custom" />)
      expect(screen.getByPlaceholderText("Search providers...")).toBeInTheDocument()
      expect(screen.getByText("Custom")).toBeInTheDocument()
    })

    it("explains a filtered-to-nothing list and offers a way out", () => {
      const onClearFilters = jest.fn()
      const onCategoryChange = jest.fn()
      render(
        <ProviderSidebar
          {...defaultProps}
          providers={[]}
          categoryFilter="custom"
          hasActiveFilters
          onClearFilters={onClearFilters}
          onCategoryChange={onCategoryChange}
          emptyState={<div data-testid="empty-state" />}
        />
      )
      expect(screen.getByText("No providers match these filters.")).toBeInTheDocument()
      expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()

      fireEvent.click(screen.getByText("Clear filters"))
      expect(onClearFilters).toHaveBeenCalled()
    })

    it("shows the real empty state when no filter is responsible", () => {
      render(
        <ProviderSidebar
          {...defaultProps}
          providers={[]}
          emptyState={<div data-testid="empty-state" />}
        />
      )
      expect(screen.getByTestId("empty-state")).toBeInTheDocument()
      expect(screen.queryByText("No providers match these filters.")).not.toBeInTheDocument()
    })

    it("treats the status filter as a filter, and clearing resets it", async () => {
      const user = userEvent.setup()
      render(
        <ControlledSidebar
          {...defaultProps}
          providers={[mockProviders[2]]}
          emptyState={<div data-testid="empty-state" />}
        />
      )
      // Narrow to "Connected" while only an unconfigured provider exists.
      await pickStatus(user, "connected")
      expect(screen.getByText("No providers match these filters.")).toBeInTheDocument()

      await user.click(screen.getByTestId("provider-filter-clear"))
      expect(screen.getByText("Google")).toBeInTheDocument()
    })
  })

  it("filters the visible list by connection status", async () => {
    const user = userEvent.setup()
    render(<ControlledSidebar {...defaultProps} />)
    await pickStatus(user, "connected")
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.queryByText("Google")).not.toBeInTheDocument()
    // Stats reflect the narrowed set.
    expect(screen.getByText("2 shown of 3 · 2 connected")).toBeInTheDocument()
    expect(defaultProps.onStatusFilterChange).toHaveBeenCalledWith("connected")
  })

  it("restores the persisted status filter on remount", () => {
    render(<ProviderSidebar {...defaultProps} statusFilter="not-configured" />)
    expect(screen.getByText("Google")).toBeInTheDocument()
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument()
  })

  it("shows only unconfigured providers when that status is chosen", async () => {
    const user = userEvent.setup()
    render(<ControlledSidebar {...defaultProps} />)
    await pickStatus(user, "not-configured")
    expect(screen.getByText("Google")).toBeInTheDocument()
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument()
    expect(screen.getByText("1 shown of 3 · 0 connected")).toBeInTheDocument()
  })

  it("adds overflow guards so the desktop sidebar stays within its layout bounds", () => {
    const { container } = render(<ProviderSidebar {...defaultProps} />)
    expect(container.firstChild).toHaveClass("min-w-0")
    expect(container.firstChild).toHaveClass("overflow-hidden")
  })
})
