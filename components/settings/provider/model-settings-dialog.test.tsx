/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ModelSettingsDialog } from "./model-settings-dialog"
import type { Model } from "@/types/provider/provider"

const mockProviderIcon = jest.fn((_props?: unknown) => <div data-testid="provider-icon" />)

// Mock UI components
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
}))

jest.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
  }: {
    value?: string | number
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  }) => <input data-testid="input" value={value} onChange={onChange} />,
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button data-testid="button" onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => (
    <label data-testid="label">{children}</label>
  ),
}))

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      data-testid="switch"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/slider", () => ({
  Slider: ({ value }: { value?: number[] }) => <div data-testid="slider" data-value={value?.[0]} />,
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
}))

jest.mock("@/components/ui/separator", () => ({
  Separator: () => <hr data-testid="separator" />,
}))

jest.mock("@/components/providers/ai/provider-icon", () => ({
  ProviderIcon: (props: unknown) => mockProviderIcon(props),
}))

const mockModel: Model = {
  id: "gpt-4",
  name: "GPT-4",
  contextLength: 8192,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsVision: true,
  supportsAudio: false,
  supportsVideo: false,
  supportsStreaming: true,
  pricing: { promptPer1M: 30, completionPer1M: 60 },
}

describe("ModelSettingsDialog", () => {
  const mockOnOpenChange = jest.fn()
  const mockOnSave = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    mockProviderIcon.mockImplementation(() => <div data-testid="provider-icon" />)
  })

  it("renders when open", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("does not render when closed", () => {
    render(
      <ModelSettingsDialog
        open={false}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })

  it("displays dialog title", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    expect(screen.getByTestId("dialog-title")).toBeInTheDocument()
  })

  it("displays capability switches", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    const switches = screen.getAllByTestId("switch")
    expect(switches.length).toBeGreaterThan(0)
  })

  it("displays input fields", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    const inputs = screen.getAllByTestId("input")
    expect(inputs.length).toBeGreaterThan(0)
  })

  it("displays separators between sections", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    const separators = screen.getAllByTestId("separator")
    expect(separators.length).toBeGreaterThan(0)
  })

  it("displays slider for max output tokens", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )
    expect(screen.getByTestId("slider")).toBeInTheDocument()
  })

  it("passes providerId to ProviderIcon so icon fallback stays catalog-backed", () => {
    render(
      <ModelSettingsDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        model={mockModel}
        providerId="openai"
        onSave={mockOnSave}
      />
    )

    expect(mockProviderIcon).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "openai", size: 20 })
    )
  })
})
