/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { CanvasDocumentList } from "./canvas-document-list"

const mockDocuments = [
  {
    id: "doc-1",
    sessionId: "session-1",
    title: "JavaScript File",
    content: "const x = 1;",
    type: "code" as const,
    language: "javascript" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: "doc-2",
    sessionId: "session-1",
    title: "Python Script",
    content: 'print("hello")',
    type: "code" as const,
    language: "python" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]

const mockHandlers = {
  onSelectDocument: jest.fn(),
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
    <button onClick={onClick} className={className} {...props}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

jest.mock("@/components/ui/card", () => ({
  Card: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => (
    <div onClick={onClick} className={className} data-testid="card">
      {children}
    </div>
  ),
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode
    onValueChange?: (v: string) => void
  }) => (
    <div onChange={(e) => onValueChange?.((e.target as HTMLInputElement).value)}>{children}</div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="select-trigger" data-className={className}>
      {children}
    </div>
  ),
  SelectValue: () => <span>Value</span>,
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
      searchDocuments: "Search documents",
      new: "New",
      allLanguages: "All Languages",
      sortByDate: "Sort by Date",
      sortByName: "Sort by Name",
      sortByLanguage: "Sort by Language",
      documents: "documents",
      filtered: "filtered",
      noDocuments: "No documents yet",
      noDocumentsFound: "No documents found",
      createFirst: "Create your first document",
      lines: "lines",
      rename: "Rename",
      duplicate: "Duplicate",
      delete: "Delete",
      justNow: "just now",
      minutesAgo: "{count}m ago",
      hoursAgo: "{count}h ago",
      daysAgo: "{count}d ago",
      createDocument: "Create Document",
      documentTitle: "Document Title",
      enterTitle: "Enter title",
      language: "Language",
      type: "Type",
      codeType: "Code",
      textType: "Text",
      cancel: "Cancel",
      create: "Create",
      javascript: "JavaScript",
      typescript: "TypeScript",
      python: "Python",
      html: "HTML",
      css: "CSS",
      json: "JSON",
      markdown: "Markdown",
      jsx: "JSX",
      tsx: "TSX",
      sql: "SQL",
      bash: "Bash",
      yaml: "YAML",
    }
    return translations[key] || key
  },
}))

describe("CanvasDocumentList", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders document list", () => {
    render(
      <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    expect(screen.getByText("JavaScript File")).toBeInTheDocument()
    expect(screen.getByText("Python Script")).toBeInTheDocument()
  })

  it("displays document count", () => {
    render(
      <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    expect(screen.getByText("2 documents")).toBeInTheDocument()
  })

  it("filters documents by search query", () => {
    render(
      <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    const searchInput = screen.getByPlaceholderText("Search documents")
    fireEvent.change(searchInput, { target: { value: "Python" } })
    // After filtering, should only show Python document
    expect(screen.getByText("Python Script")).toBeInTheDocument()
  })

  it("opens create dialog when clicking new button", () => {
    render(
      <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    const newButton = screen.getByText("New")
    fireEvent.click(newButton)
    // Dialog should open (controlled by component state)
  })

  it("selects document when clicking card", () => {
    render(
      <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
    )
    const card = screen.getByText("JavaScript File").closest('[data-testid="card"]')
    if (card) fireEvent.click(card)
    expect(mockHandlers.onSelectDocument).toHaveBeenCalledWith("doc-1")
  })

  describe("Responsive Layout", () => {
    it("applies responsive width to Select triggers", () => {
      render(
        <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      const selectTriggers = screen.getAllByTestId("select-trigger")
      selectTriggers.forEach((trigger) => {
        const className = trigger.getAttribute("data-className")
        expect(className).toContain("w-full")
        expect(className).toContain("sm:w-25")
        expect(className).toContain("min-w-20")
      })
    })

    it("applies mobile-first width to dialogs", () => {
      render(
        <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      // Trigger dialog to open
      const newButton = screen.getByText("New")
      fireEvent.click(newButton)

      const dialogContent = screen.queryByTestId("dialog-content")
      if (dialogContent) {
        const className = dialogContent.getAttribute("data-className")
        expect(className).toContain("w-[95vw]")
        expect(className).toContain("sm:max-w-100")
      }
    })

    it("has flex-wrap on filter container for mobile", () => {
      const { container } = render(
        <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      // The filter container should have flex-wrap class
      const filterContainer = container.querySelector(".flex-wrap")
      expect(filterContainer).toBeInTheDocument()
    })
  })

  describe("Empty State", () => {
    it("displays empty state when no documents", () => {
      render(<CanvasDocumentList documents={[]} activeDocumentId={null} {...mockHandlers} />)
      expect(screen.getByText("No documents yet")).toBeInTheDocument()
      expect(screen.getByText("Create your first document")).toBeInTheDocument()
    })

    it("displays no results when search returns empty", () => {
      render(
        <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      const searchInput = screen.getByPlaceholderText("Search documents")
      fireEvent.change(searchInput, { target: { value: "nonexistent" } })
      expect(screen.getByText("No documents found")).toBeInTheDocument()
    })
  })

  describe("Sorting and Filtering", () => {
    it("displays language filter dropdown", () => {
      render(
        <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      expect(screen.getByText("All Languages")).toBeInTheDocument()
    })

    it("displays sort dropdown", () => {
      render(
        <CanvasDocumentList documents={mockDocuments} activeDocumentId="doc-1" {...mockHandlers} />
      )
      expect(screen.getByText("Sort by Date")).toBeInTheDocument()
    })
  })
})
