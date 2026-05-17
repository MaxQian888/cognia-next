/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { WelcomeA2UIDemo, WelcomeA2UIDemoCompact } from "./welcome-a2ui-demo"

// Mock A2UI hooks
const mockSurface = {
  id: "welcome-demo-surface",
  components: [],
  dataModel: {},
}

const mockCreateQuickSurface = jest.fn()
const mockGetSurface = jest.fn(() => mockSurface)
const mockDeleteSurface = jest.fn()

jest.mock("@/hooks/a2ui", () => ({
  useA2UI: () => ({
    createQuickSurface: mockCreateQuickSurface,
    getSurface: mockGetSurface,
    deleteSurface: mockDeleteSurface,
    registerSurface: jest.fn(),
    unregisterSurface: jest.fn(),
    updateComponents: jest.fn(),
    handleAction: jest.fn(),
  }),
}))

// Mock A2UI components
jest.mock("@/components/a2ui", () => ({
  A2UIInlineSurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="a2ui-surface" data-surface-id={surfaceId}>
      A2UI Surface
    </div>
  ),
}))

// Mock UI components
jest.mock("@/components/ui/button")

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="dialog" data-open={open}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

describe("WelcomeA2UIDemo", () => {
  const defaultProps = {
    onAction: jest.fn(),
    onSuggestionClick: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    // Reset localStorage mock
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: jest.fn(() => null),
        setItem: jest.fn(),
        clear: jest.fn(),
      },
      writable: true,
    })
  })

  describe("Initial render", () => {
    it("renders trigger button when not shown before", () => {
      render(<WelcomeA2UIDemo {...defaultProps} />)

      expect(screen.getByText(/Try Interactive Demo/)).toBeInTheDocument()
    })

    it("returns null when already shown (localStorage)", () => {
      Object.defineProperty(window, "localStorage", {
        value: {
          getItem: jest.fn(() => "true"),
          setItem: jest.fn(),
        },
        writable: true,
      })

      const { container } = render(<WelcomeA2UIDemo {...defaultProps} />)

      expect(container.firstChild).toBeNull()
    })

    it("applies custom className", () => {
      const { container } = render(<WelcomeA2UIDemo {...defaultProps} className="custom-class" />)

      expect(container.firstChild).toHaveClass("custom-class")
    })
  })

  describe("Dialog interaction", () => {
    it("opens dialog when trigger button is clicked", () => {
      render(<WelcomeA2UIDemo {...defaultProps} />)

      const triggerButton = screen.getByText(/Try Interactive Demo/)
      fireEvent.click(triggerButton)

      expect(screen.getByTestId("dialog")).toBeInTheDocument()
    })

    it("renders A2UI surface in dialog when open", () => {
      render(<WelcomeA2UIDemo {...defaultProps} />)

      const triggerButton = screen.getByText(/Try Interactive Demo/)
      fireEvent.click(triggerButton)

      expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument()
    })

    it("has correct surface ID", () => {
      render(<WelcomeA2UIDemo {...defaultProps} />)

      const triggerButton = screen.getByText(/Try Interactive Demo/)
      fireEvent.click(triggerButton)

      const surface = screen.getByTestId("a2ui-surface")
      expect(surface).toHaveAttribute("data-surface-id", "welcome-demo-surface")
    })
  })

  describe("Surface lifecycle", () => {
    it("creates surface on mount", () => {
      render(<WelcomeA2UIDemo {...defaultProps} />)

      expect(mockCreateQuickSurface).toHaveBeenCalledWith(
        "welcome-demo-surface",
        expect.any(Array),
        expect.any(Object),
        expect.any(Object)
      )
    })

    it("deletes surface on unmount", () => {
      const { unmount } = render(<WelcomeA2UIDemo {...defaultProps} />)

      unmount()

      expect(mockDeleteSurface).toHaveBeenCalledWith("welcome-demo-surface")
    })
  })

  describe("Props", () => {
    it("renders without onAction callback", () => {
      render(<WelcomeA2UIDemo onSuggestionClick={jest.fn()} />)

      expect(screen.getByText(/Try Interactive Demo/)).toBeInTheDocument()
    })

    it("renders without onSuggestionClick callback", () => {
      render(<WelcomeA2UIDemo onAction={jest.fn()} />)

      expect(screen.getByText(/Try Interactive Demo/)).toBeInTheDocument()
    })

    it("renders with showSettings true", () => {
      render(<WelcomeA2UIDemo {...defaultProps} showSettings />)

      expect(screen.getByText(/Try Interactive Demo/)).toBeInTheDocument()
    })

    it("renders with showSettings false", () => {
      render(<WelcomeA2UIDemo {...defaultProps} showSettings={false} />)

      expect(screen.getByText(/Try Interactive Demo/)).toBeInTheDocument()
    })
  })
})

describe("WelcomeA2UIDemoCompact", () => {
  const defaultProps = {
    onAction: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSurface.mockReturnValue(mockSurface)
  })

  it("renders compact surface", () => {
    render(<WelcomeA2UIDemoCompact {...defaultProps} />)

    expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    const { container } = render(
      <WelcomeA2UIDemoCompact {...defaultProps} className="compact-class" />
    )

    expect(container.firstChild).toHaveClass("compact-class")
  })

  it("returns null when surface is not ready", () => {
    mockGetSurface.mockReturnValue(undefined as unknown as typeof mockSurface)

    const { container } = render(<WelcomeA2UIDemoCompact {...defaultProps} />)

    expect(container.firstChild).toBeNull()
  })
})
