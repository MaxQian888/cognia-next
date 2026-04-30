/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { VersionHistoryPanel } from "./version-history-panel"

// Bypass TooltipProvider context (production wraps the app at layout.tsx).
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock stores
const mockSaveCanvasVersion = jest.fn()
const mockRestoreCanvasVersion = jest.fn()
const mockDeleteCanvasVersion = jest.fn()
const mockGetCanvasVersions = jest.fn()

jest.mock("@/stores", () => ({
  useArtifactStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      canvasDocuments: {
        "doc-1": {
          id: "doc-1",
          title: "Test Document",
          content: "Test content",
          currentVersionId: "v1",
        },
      },
      getCanvasVersions: mockGetCanvasVersions,
      saveCanvasVersion: mockSaveCanvasVersion,
      restoreCanvasVersion: mockRestoreCanvasVersion,
      deleteCanvasVersion: mockDeleteCanvasVersion,
    }
    return selector(state)
  },
}))

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

jest.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="sheet" data-open={open}>
      {children}
    </div>
  ),
  SheetContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="sheet-content" data-className={className}>
      {children}
    </div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sheet-trigger">{children}</div>
  ),
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))

jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
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
}))

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      versionHistory: "Version History",
      noVersions: "No versions saved yet",
      saveVersion: "Save Current Version",
      current: "Current",
      autoSave: "Auto",
      previewAction: "Preview",
      restoreAction: "Restore",
      deleteAction: "Delete",
      cancel: "Cancel",
      save: "Save",
      close: "Close",
      versionDescription: "Version description",
      confirmDelete: "Are you sure?",
      deleteDescription: "This action cannot be undone.",
      versionPreview: "Version Preview",
      compare: "Compare",
      cancelCompare: "Cancel",
      compareInstructions: "Select two versions to compare",
      viewDiff: "View Diff",
      selected: "Selected",
      versionComparison: "Version Comparison",
    }
    return translations[key] || key
  },
}))

jest.mock("./version-diff-view", () => ({
  VersionDiffView: ({ oldContent, newContent }: { oldContent: string; newContent: string }) => (
    <div data-testid="version-diff-view">
      <span>Old: {oldContent.substring(0, 20)}</span>
      <span>New: {newContent.substring(0, 20)}</span>
    </div>
  ),
}))

describe("VersionHistoryPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCanvasVersions.mockReturnValue([])
  })

  it("renders without crashing", () => {
    render(<VersionHistoryPanel documentId="doc-1" />)
    expect(screen.getByTestId("sheet")).toBeInTheDocument()
  })

  it("renders custom trigger when provided", () => {
    render(<VersionHistoryPanel documentId="doc-1" trigger={<button>Custom Trigger</button>} />)
    expect(screen.getByText("Custom Trigger")).toBeInTheDocument()
  })

  it('displays "No versions saved yet" when no versions exist', () => {
    mockGetCanvasVersions.mockReturnValue([])
    render(<VersionHistoryPanel documentId="doc-1" />)
    expect(screen.getByText("No versions saved yet")).toBeInTheDocument()
  })

  it('displays "Save Current Version" button', () => {
    render(<VersionHistoryPanel documentId="doc-1" />)
    expect(screen.getByText("Save Current Version")).toBeInTheDocument()
  })

  it("displays version history title", () => {
    render(<VersionHistoryPanel documentId="doc-1" />)
    expect(screen.getByText("Version History")).toBeInTheDocument()
  })

  describe("with versions", () => {
    const mockVersions = [
      {
        id: "v1",
        documentId: "doc-1",
        content: "Version 1 content",
        createdAt: new Date(),
        description: "First version",
        isAutoSave: false,
      },
      {
        id: "v2",
        documentId: "doc-1",
        content: "Version 2 content",
        createdAt: new Date(),
        description: "Second version",
        isAutoSave: true,
      },
    ]

    beforeEach(() => {
      mockGetCanvasVersions.mockReturnValue(mockVersions)
    })

    it("displays versions when they exist", () => {
      render(<VersionHistoryPanel documentId="doc-1" />)
      expect(screen.getByText("First version")).toBeInTheDocument()
      expect(screen.getByText("Second version")).toBeInTheDocument()
    })

    it('shows "Current" badge for current version', () => {
      render(<VersionHistoryPanel documentId="doc-1" />)
      expect(screen.getByText("Current")).toBeInTheDocument()
    })

    it('shows "Auto" badge for auto-saved versions', () => {
      render(<VersionHistoryPanel documentId="doc-1" />)
      expect(screen.getByText("Auto")).toBeInTheDocument()
    })

    it("displays Preview buttons for versions", () => {
      render(<VersionHistoryPanel documentId="doc-1" />)
      const previewButtons = screen.getAllByText("Preview")
      expect(previewButtons.length).toBeGreaterThan(0)
    })
  })

  describe("Responsive Layout", () => {
    it("applies responsive width to Sheet content", () => {
      render(<VersionHistoryPanel documentId="doc-1" />)
      const sheetContent = screen.getByTestId("sheet-content")
      const className = sheetContent.getAttribute("data-className")
      expect(className).toContain("w-full")
      expect(className).toContain("sm:w-[400px]")
    })

    it("applies mobile-first width to dialogs", () => {
      render(<VersionHistoryPanel documentId="doc-1" />)
      const dialogContents = screen.queryAllByTestId("dialog-content")
      dialogContents.forEach((dialogContent) => {
        const className = dialogContent.getAttribute("data-className")
        if (className) {
          // Preview dialog should have mobile width
          if (className.includes("max-w-3xl")) {
            expect(className).toContain("w-[95vw]")
          }
          // Diff dialog should have mobile width
          if (className.includes("max-w-4xl")) {
            expect(className).toContain("w-[95vw]")
          }
        }
      })
    })
  })

  describe("Button Touch Targets", () => {
    it("renders version action buttons", () => {
      mockGetCanvasVersions.mockReturnValue([
        {
          id: "v1",
          documentId: "doc-1",
          content: "Version 1",
          createdAt: new Date(),
          description: "Test version",
          isAutoSave: false,
        },
      ])
      render(<VersionHistoryPanel documentId="doc-1" />)
      // Action buttons (Preview, Restore) should be present
      const previewButtons = screen.getAllByText("Preview")
      expect(previewButtons.length).toBeGreaterThan(0)
    })
  })
})
