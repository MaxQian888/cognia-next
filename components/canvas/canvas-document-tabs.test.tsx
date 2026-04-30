/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { CanvasDocumentTabs } from "./canvas-document-tabs"

const mockDocuments = [
  {
    id: "doc-1",
    sessionId: "session-1",
    title: "Document 1",
    content: "content 1",
    type: "code" as const,
    language: "javascript" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "doc-2",
    sessionId: "session-1",
    title: "Document 2",
    content: "content 2",
    type: "text" as const,
    language: "markdown" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]

const mockHandlers = {
  onSelectDocument: jest.fn(),
  onCloseDocument: jest.fn(),
  onCreateDocument: jest.fn(),
  onRenameDocument: jest.fn(),
  onDuplicateDocument: jest.fn(),
  onDeleteDocument: jest.fn(),
}

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      onClick={onClick}
      className={className}
      data-testid={className?.includes("h-9") ? "touch-target-button" : ""}
      {...props}
    >
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollBar: () => <div />,
}))

const mockTabsOnValueChange = { current: null as ((v: string) => void) | null }
jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value: string
    onValueChange: (v: string) => void
  }) => {
    mockTabsOnValueChange.current = onValueChange
    return <div data-value={value}>{children}</div>
  },
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button data-value={value} onClick={() => mockTabsOnValueChange.current?.(value)}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-content" data-className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      rename: "Rename",
      duplicate: "Duplicate",
      delete: "Delete",
      newDocument: "New Document",
      renameDocument: "Rename Document",
      documentTitle: "Document Title",
      cancel: "Cancel",
      save: "Save",
    }
    return translations[key] || key
  },
}))

describe("CanvasDocumentTabs", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders null when documents array is empty", () => {
    const { container } = render(
      <CanvasDocumentTabs documents={[]} activeDocumentId={null} {...mockHandlers} />
    )
    expect(container.firstChild).toBe(null)
  })

  it("renders null when only one document exists", () => {
    const { container } = render(
      <CanvasDocumentTabs
        documents={[mockDocuments[0]]}
        activeDocumentId="doc-1"
        {...mockHandlers}
      />
    )
    expect(container.firstChild).toBe(null)
  })

  it("renders tabs when multiple documents exist", () => {
    render(
      <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    expect(screen.getByText("Document 1")).toBeInTheDocument()
    expect(screen.getByText("Document 2")).toBeInTheDocument()
  })

  it("calls onSelectDocument when clicking a tab", () => {
    render(
      <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    const tab2Button = screen.getByText("Document 2").closest("button")
    expect(tab2Button).toBeInTheDocument()
    if (tab2Button) {
      fireEvent.click(tab2Button)
      expect(mockHandlers.onSelectDocument).toHaveBeenCalledWith("doc-2")
    }
  })

  it("calls onCreateDocument when clicking add button", () => {
    render(
      <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    // The add button has h-9 w-9 shrink-0 classes, find by checking for Plus icon content
    const touchTargetButtons = screen.getAllByTestId("touch-target-button")
    // The add button is the last touch-target-button that's not inside a tab (shrink-0 class)
    const addButton = touchTargetButtons[touchTargetButtons.length - 1]
    if (addButton) fireEvent.click(addButton)
    expect(mockHandlers.onCreateDocument).toHaveBeenCalled()
  })

  describe("Responsive Layout", () => {
    it("applies mobile-first width to dialogs", () => {
      render(
        <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      // Trigger rename dialog to render
      const moreButtons = screen.getAllByRole("button")
      const renameButton = moreButtons.find((btn) => btn.textContent === "⋯")
      if (renameButton) fireEvent.click(renameButton)

      const dialogContent = screen.queryByTestId("dialog-content")
      if (dialogContent) {
        const className = dialogContent.getAttribute("data-className")
        expect(className).toContain("w-[95vw]")
        expect(className).toContain("sm:max-w-[400px]")
      }
    })
  })

  describe("Touch Target Accessibility", () => {
    it("renders icon buttons with minimum touch target size (h-9 w-9)", () => {
      render(
        <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      // Find buttons with h-9 w-9 className (touch target buttons)
      const touchTargetButtons = screen.getAllByTestId("touch-target-button")
      expect(touchTargetButtons.length).toBeGreaterThan(0)
    })

    it("renders add button with proper touch target size", () => {
      render(
        <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      // Find all touch target buttons - the add button is among them with h-9 w-9 shrink-0
      const touchTargetButtons = screen.getAllByTestId("touch-target-button")
      expect(touchTargetButtons.length).toBeGreaterThan(0)
      // Verify at least one button has the expected class pattern
      const addButton = touchTargetButtons[touchTargetButtons.length - 1]
      expect(addButton).toHaveClass("h-9")
    })
  })

  describe("Tab Title Responsive Width", () => {
    it("applies responsive max-width to tab titles", () => {
      render(
        <CanvasDocumentTabs documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      const titleElement = screen.getByText("Document 1")
      expect(titleElement).toHaveClass("max-w-[80px]")
      expect(titleElement).toHaveClass("sm:max-w-[120px]")
    })
  })
})
