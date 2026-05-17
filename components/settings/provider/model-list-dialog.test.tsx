/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ModelListDialog } from "./model-list-dialog"

import type { ModelConfig } from "@/types/provider"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const translate = ((key: string, params?: Record<string, unknown>) => {
      if (key === "modelSelectionDescription") {
        throw new Error(
          "MISSING_MESSAGE: Could not resolve `providers.modelSelectionDescription` in messages for locale `en`."
        )
      }

      if (key === "modelsSelected") {
        return `${params?.count ?? 0} models enabled`
      }

      return key
    }) as ((key: string, params?: Record<string, unknown>) => string) & {
      has: (key: string) => boolean
    }

    translate.has = (key: string) => key !== "modelSelectionDescription"

    return translate
  },
}))

// Mock UI components
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({
    children,
    showCloseButton,
    className,
  }: {
    children: React.ReactNode
    showCloseButton?: boolean
    className?: string
  }) => (
    <div
      data-testid="dialog-content"
      data-show-close-button={showCloseButton === false ? "false" : "true"}
      className={className}
    >
      {children}
    </div>
  ),
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-header" className={className}>
      {children}
    </div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-testid="dialog-description">{children}</p>
  ),
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-footer" className={className}>
      {children}
    </div>
  ),
  DialogClose: ({ children }: { children: React.ReactElement<{ "data-testid"?: string }> }) =>
    React.cloneElement(children, {
      "data-testid": children.props["data-testid"] ?? "dialog-close",
    }),
}))

jest.mock("@/components/ui/input", () => ({
  Input: ({
    placeholder,
    onChange,
  }: {
    placeholder?: string
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  }) => <input data-testid="search-input" placeholder={placeholder} onChange={onChange} />,
}))

jest.mock("@/components/ui/button")

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      data-testid="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/scroll-area")

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (value: string) => void
  }) => (
    <div data-testid="tabs" data-value={value} onClick={() => onValueChange?.("all")}>
      {children}
    </div>
  ),
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tabs-list">{children}</div>
  ),
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button data-testid={`tab-trigger-${value}`}>{children}</button>
  ),
}))

const mockModels: ModelConfig[] = [
  {
    id: "gpt-4",
    name: "GPT-4",
    contextLength: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsAudio: false,
    supportsVideo: false,
    supportsStreaming: true,
  },
  {
    id: "gpt-3.5-turbo",
    name: "GPT-3.5 Turbo",
    contextLength: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsStreaming: true,
  },
]

describe("ModelListDialog", () => {
  const mockOnOpenChange = jest.fn()
  const mockOnModelsChange = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders when open", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
  })

  it("does not render when closed", () => {
    render(
      <ModelListDialog
        open={false}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
  })

  it("displays search input", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )
    expect(screen.getByTestId("search-input")).toBeInTheDocument()
  })

  it("displays model checkboxes", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )
    const checkboxes = screen.getAllByTestId("checkbox")
    expect(checkboxes.length).toBeGreaterThan(0)
  })

  it("displays filter tabs", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )
    expect(screen.getByTestId("tabs")).toBeInTheDocument()
    expect(screen.getByTestId("tabs-list")).toBeInTheDocument()
  })

  it("displays filter tab triggers for each filter type", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )
    expect(screen.getByTestId("tab-trigger-all")).toBeInTheDocument()
    expect(screen.getByTestId("tab-trigger-vision")).toBeInTheDocument()
    expect(screen.getByTestId("tab-trigger-tools")).toBeInTheDocument()
    expect(screen.getByTestId("tab-trigger-reasoning")).toBeInTheDocument()
  })

  it("disables the built-in dialog close button and keeps a single X close control", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )

    expect(screen.getByTestId("dialog-content")).toHaveAttribute("data-show-close-button", "false")
    expect(screen.getAllByRole("button", { name: "" })).toHaveLength(1)
  })

  it("uses responsive layout classes for toolbar, list items, and footer", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )

    expect(screen.getByTestId("dialog-content").className).toContain("sm:max-w-[500px]")
    expect(screen.getByTestId("dialog-content").className).toContain("max-w-[calc(100vw-2rem)]")
    expect(screen.getByTestId("dialog-footer").className).toContain("max-md:flex-col")
    expect(screen.getByRole("button", { name: /GPT-4/i }).className).toContain("max-sm:flex-col")
  })

  it("does not nest checkbox buttons inside a button element", () => {
    const { container } = render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )

    expect(container.querySelector("button button")).toBeNull()
  })

  it("falls back when an optional translation key is missing", () => {
    render(
      <ModelListDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        models={mockModels}
        selectedModels={[]}
        onModelsChange={mockOnModelsChange}
        providerName="OpenAI"
      />
    )

    expect(
      screen.getByText("Search, filter, and enable the models available for this provider.")
    ).toBeInTheDocument()
  })
})
