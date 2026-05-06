/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderSidebar } from "./provider-sidebar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === "sidebar.stats") return `${params?.total} providers · ${params?.active} connected`
    if (key === "sidebar.searchPlaceholder") return "Search providers..."
    if (key === "sidebar.addButton") return "Add"
    if (key === "sidebar.modelCompare") return "Model Compare"
    return key
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

  it("adds overflow guards so the desktop sidebar stays within its layout bounds", () => {
    const { container } = render(<ProviderSidebar {...defaultProps} />)

    expect(container.firstChild).toHaveClass("min-w-0")
    expect(container.firstChild).toHaveClass("overflow-hidden")
    expect(container.querySelector('[data-slot="tabs-list"]')).toHaveClass("w-full")
  })
})
