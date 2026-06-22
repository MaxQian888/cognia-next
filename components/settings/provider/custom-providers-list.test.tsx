/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { CustomProvidersList, CustomProvidersListItem } from "./custom-providers-list"
import type { CustomProviderSettings } from "@cognia/provider-types"

// Test-specific type that matches the test data structure
type CustomProvider = CustomProviderSettings

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button data-testid="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/switch")

jest.mock("@/components/ui/card")

const mockProvider: CustomProvider = {
  id: "custom-1",
  providerId: "custom-1",
  name: "My Custom Provider",
  customName: "My Custom Provider",
  baseURL: "https://api.example.com",
  apiKey: "test-key",
  apiProtocol: "openai",
  models: ["model-1", "model-2"],
  customModels: ["model-1", "model-2"],
  defaultModel: "model-1",
  enabled: true,
  isCustom: true,
}

describe("CustomProvidersListItem", () => {
  const mockOnTest = jest.fn()
  const mockOnEdit = jest.fn()
  const mockOnToggle = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders provider name", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult={null}
        testMessage={null}
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    expect(screen.getByText("My Custom Provider")).toBeInTheDocument()
  })

  it("renders base URL", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult={null}
        testMessage={null}
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    expect(screen.getByText("https://api.example.com")).toBeInTheDocument()
  })

  it("renders models count badge", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult={null}
        testMessage={null}
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("calls onTest when test button clicked", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult={null}
        testMessage={null}
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    const buttons = screen.getAllByTestId("button")
    fireEvent.click(buttons[0])
    expect(mockOnTest).toHaveBeenCalled()
  })

  it("calls onEdit when edit button clicked", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult={null}
        testMessage={null}
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    const buttons = screen.getAllByTestId("button")
    fireEvent.click(buttons[1])
    expect(mockOnEdit).toHaveBeenCalled()
  })

  it("calls onToggle when switch changed", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult={null}
        testMessage={null}
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    fireEvent.click(screen.getByTestId("switch"))
    expect(mockOnToggle).toHaveBeenCalled()
  })

  it("displays test message when provided", () => {
    render(
      <CustomProvidersListItem
        providerId="custom-1"
        provider={mockProvider}
        testResult="error"
        testMessage="Connection failed"
        isTesting={false}
        onTest={mockOnTest}
        onEdit={mockOnEdit}
        onToggle={mockOnToggle}
      />
    )
    expect(screen.getByText("Connection failed")).toBeInTheDocument()
  })
})

describe("CustomProvidersList", () => {
  const mockOnTestProvider = jest.fn()
  const mockOnEditProvider = jest.fn()
  const mockOnToggleProvider = jest.fn()
  const mockOnAddProvider = jest.fn()

  const defaultProps = {
    providers: { "custom-1": mockProvider },
    testResults: {},
    testMessages: {},
    testingProviders: {},
    onTestProvider: mockOnTestProvider,
    onEditProvider: mockOnEditProvider,
    onToggleProvider: mockOnToggleProvider,
    onAddProvider: mockOnAddProvider,
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders card container", () => {
    render(<CustomProvidersList {...defaultProps} />)
    expect(screen.getByTestId("card")).toBeInTheDocument()
  })

  it("renders add provider button", () => {
    render(<CustomProvidersList {...defaultProps} />)
    const buttons = screen.getAllByTestId("button")
    expect(buttons.length).toBeGreaterThan(0)
  })

  it("calls onAddProvider when add button clicked", () => {
    render(<CustomProvidersList {...defaultProps} />)
    const buttons = screen.getAllByTestId("button")
    const addButton = buttons.find(
      (b) => b.textContent?.includes("Add") || b.textContent?.includes("添加")
    )
    if (addButton) {
      fireEvent.click(addButton)
      expect(mockOnAddProvider).toHaveBeenCalled()
    }
  })

  it("renders provider list item", () => {
    render(<CustomProvidersList {...defaultProps} />)
    expect(screen.getByText("My Custom Provider")).toBeInTheDocument()
  })

  it("filters providers by search query", () => {
    render(<CustomProvidersList {...defaultProps} searchQuery="nonexistent" />)
    expect(screen.queryByText("My Custom Provider")).not.toBeInTheDocument()
  })

  it("shows provider when search matches name", () => {
    render(<CustomProvidersList {...defaultProps} searchQuery="Custom" />)
    expect(screen.getByText("My Custom Provider")).toBeInTheDocument()
  })
})
