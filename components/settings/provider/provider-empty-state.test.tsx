/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderEmptyState } from "./provider-empty-state"

// Mock UI components
jest.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
  }: {
    children: React.ReactNode
    onClick?: () => void
    variant?: string
  }) => (
    <button data-testid={`button-${variant || "default"}`} onClick={onClick}>
      {children}
    </button>
  ),
}))

describe("ProviderEmptyState", () => {
  const mockOnAddProvider = jest.fn()
  const mockOnImportSettings = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders without crashing", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    // Component renders with buttons
    expect(screen.getByTestId("button-default")).toBeInTheDocument()
    expect(screen.getByTestId("button-outline")).toBeInTheDocument()
  })

  it("displays empty state title", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    // Uses translation key when translation not available
    expect(screen.getByRole("heading")).toBeInTheDocument()
  })

  it("displays Add Provider button", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    expect(screen.getByTestId("button-default")).toBeInTheDocument()
  })

  it("calls onAddProvider when Add Provider button is clicked", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    fireEvent.click(screen.getByTestId("button-default"))
    expect(mockOnAddProvider).toHaveBeenCalledTimes(1)
  })

  it("displays Import Settings button", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    expect(screen.getByTestId("button-outline")).toBeInTheDocument()
  })

  it("calls onImportSettings when Import Settings button is clicked", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    fireEvent.click(screen.getByTestId("button-outline"))
    expect(mockOnImportSettings).toHaveBeenCalledTimes(1)
  })

  it("wraps content in Card component", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    expect(screen.getByTestId("card")).toBeInTheDocument()
    expect(screen.getByTestId("card-content")).toBeInTheDocument()
  })

  it("Card has border-dashed class", () => {
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
      />
    )
    const card = screen.getByTestId("card")
    expect(card).toHaveClass("border-dashed")
  })

  it("renders checklist guidance actions and calls handler", () => {
    const onAction = jest.fn()
    render(
      <ProviderEmptyState
        onAddProvider={mockOnAddProvider}
        onImportSettings={mockOnImportSettings}
        guidanceItems={[
          {
            id: "credential",
            label: "Add credentials",
            description: "Missing API key",
            actionLabel: "Fix Now",
            onAction,
          },
        ]}
      />
    )

    expect(screen.getByText("Add credentials")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Fix Now"))
    expect(onAction).toHaveBeenCalledTimes(1)
  })
})
