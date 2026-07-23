/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderSidebar } from "./provider-sidebar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      "sidebar.searchPlaceholder": "Search providers...",
      "sidebar.addButton": "Add",
      "sidebar.modelCompare": "Model Compare",
      "sidebar.statusLabel": "Filter by status",
      "sidebar.statusAll": "All status",
      "sidebar.statusConnected": "Connected",
      "sidebar.statusUnconfigured": "Unconfigured",
      "sidebar.statusError": "Error",
      "sidebar.noMatches": "No providers match these filters.",
      "sidebar.clearFilters": "Clear filters",
      "categories.all": "All",
      "categories.ai": "AI",
      "categories.local": "Local",
      "categories.voice": "Voice",
      "categories.vision": "Vision",
      "categories.custom": "Custom",
    }
    if (key === "sidebar.stats") return `${params?.total} providers · ${params?.active} connected`
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

describe("ProviderSidebar", () => {
  const defaultProps = {
    providers: mockProviders,
    selectedId: null as string | null,
    onSelect: jest.fn(),
    onCompareClick: jest.fn(),
    categoryFilter: "all" as string,
    onCategoryChange: jest.fn(),
    searchQuery: "",
    onSearchChange: jest.fn(),
    addButton: <button>Add</button>,
  }

  it("renders all providers in the list", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("Google")).toBeInTheDocument()
  })

  it("shows correct stats", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByText("3 providers · 2 connected")).toBeInTheDocument()
  })

  it("renders search input", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByPlaceholderText("Search providers...")).toBeInTheDocument()
  })

  it("renders Model Compare button", () => {
    render(<ProviderSidebar {...defaultProps} />)
    expect(screen.getByText("Model Compare")).toBeInTheDocument()
  })

  it("renders i18n-wired category tabs (no hard-coded labels)", () => {
    render(<ProviderSidebar {...defaultProps} />)
    for (const label of ["All", "AI", "Local", "Voice", "Vision", "Custom"]) {
      expect(screen.getByRole("tab", { name: label })).toBeInTheDocument()
    }
  })

  it("makes the category tab strip horizontally scrollable instead of squashing labels", () => {
    const { container } = render(<ProviderSidebar {...defaultProps} />)
    const list = container.querySelector('[data-slot="tabs-list"]')
    // Auto width + nowrap triggers = the strip can overflow and scroll.
    expect(list).toHaveClass("w-max")
    expect(list?.parentElement).toHaveClass("overflow-x-auto")
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

    it("treats its own status filter as a filter, and clearing resets it", () => {
      render(
        <ProviderSidebar
          {...defaultProps}
          providers={[mockProviders[2]]}
          emptyState={<div data-testid="empty-state" />}
        />
      )
      // Narrow to "Connected" while only an unconfigured provider exists.
      fireEvent.click(screen.getByText("Connected"))
      expect(screen.getByText("No providers match these filters.")).toBeInTheDocument()

      fireEvent.click(screen.getByText("Clear filters"))
      expect(screen.getByText("Google")).toBeInTheDocument()
    })
  })

  it("filters the visible list by connection status", () => {
    render(<ProviderSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Connected" }))
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.queryByText("Google")).not.toBeInTheDocument()
    // Stats reflect the narrowed set.
    expect(screen.getByText("2 providers · 2 connected")).toBeInTheDocument()
  })

  it("shows only unconfigured providers when that status is chosen", () => {
    render(<ProviderSidebar {...defaultProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Unconfigured" }))
    expect(screen.getByText("Google")).toBeInTheDocument()
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument()
    expect(screen.getByText("1 providers · 0 connected")).toBeInTheDocument()
  })

  it("adds overflow guards so the desktop sidebar stays within its layout bounds", () => {
    const { container } = render(<ProviderSidebar {...defaultProps} />)
    expect(container.firstChild).toHaveClass("min-w-0")
    expect(container.firstChild).toHaveClass("overflow-hidden")
  })
})
