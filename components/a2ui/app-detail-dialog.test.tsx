/**
 * A2UI App Detail Dialog Component Tests
 */

import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AppDetailDialog, type AppDetailDialogProps } from "./app-detail-dialog"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

// Mock ResizeObserver
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}))

// Mock Dialog so content renders in JSDOM without Portal
jest.mock("@/components/ui/dialog")

// Mock Tabs with stateful tab switching
jest.mock("@/components/ui/tabs", () => {
  const TabsContext = React.createContext<{ active: string; setActive: (v: string) => void }>({
    active: "info",
    setActive: () => {},
  })
  return {
    Tabs: ({
      children,
      defaultValue,
    }: {
      children: React.ReactNode
      defaultValue?: string
      className?: string
    }) => {
      const [active, setActive] = React.useState(defaultValue || "info")
      return (
        <TabsContext.Provider value={{ active, setActive }}>
          <div data-testid="tabs">{children}</div>
        </TabsContext.Provider>
      )
    },
    TabsList: ({ children }: { children: React.ReactNode; className?: string }) => (
      <div>{children}</div>
    ),
    TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => {
      const { setActive } = React.useContext(TabsContext)
      return (
        <button onClick={() => setActive(value)} data-value={value}>
          {children}
        </button>
      )
    },
    TabsContent: ({
      children,
      value,
    }: {
      children: React.ReactNode
      value: string
      className?: string
    }) => {
      const { active } = React.useContext(TabsContext)
      return active === value ? <div data-testid={`tab-${value}`}>{children}</div> : null
    },
  }
})

const createMockApp = (overrides: Partial<A2UIAppInstance> = {}): A2UIAppInstance => ({
  id: "test-app-1",
  templateId: "template-1",
  name: "Test Application",
  createdAt: Date.now() - 86400000,
  lastModified: Date.now() - 3600000,
  description: "This is a test application",
  version: "1.0.0",
  category: "productivity",
  tags: ["test", "demo"],
  author: {
    name: "Test Author",
    email: "test@example.com",
    url: "https://example.com",
  },
  stats: {
    views: 100,
    uses: 50,
    rating: 4.5,
    ratingCount: 10,
  },
  ...overrides,
})

const createMockTemplate = (overrides: Partial<A2UIAppTemplate> = {}): A2UIAppTemplate => ({
  id: "template-1",
  name: "Test Template",
  description: "A test template",
  icon: "CheckSquare",
  category: "productivity",
  components: [],
  dataModel: {},
  tags: ["test"],
  ...overrides,
})

const renderDialog = (props: Partial<AppDetailDialogProps> = {}) => {
  const defaultProps: AppDetailDialogProps = {
    app: createMockApp(),
    template: createMockTemplate(),
    open: true,
    onOpenChange: jest.fn(),
    ...props,
  }
  return render(<AppDetailDialog {...defaultProps} />)
}

describe("AppDetailDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("should render dialog when open", () => {
      renderDialog()

      expect(screen.getByText("App Details")).toBeInTheDocument()
    })

    it("should not render when app is null", () => {
      renderDialog({ app: null })

      expect(screen.queryByText("App Details")).not.toBeInTheDocument()
    })

    it("should show app name", () => {
      renderDialog()

      expect(screen.getByText("Test Application")).toBeInTheDocument()
    })

    it("should show version badge", () => {
      renderDialog()

      expect(screen.getByText("v1.0.0")).toBeInTheDocument()
    })

    it("should show template name badge", () => {
      renderDialog()

      expect(screen.getByText("Test Template")).toBeInTheDocument()
    })

    it("should show description", () => {
      renderDialog()

      expect(screen.getByText("This is a test application")).toBeInTheDocument()
    })

    it('should show "No description" when no description', () => {
      renderDialog({
        app: createMockApp({ description: undefined }),
      })

      expect(screen.getByText("No description")).toBeInTheDocument()
    })
  })

  describe("tabs", () => {
    it("should render all tabs", () => {
      renderDialog()

      expect(screen.getByText(/Basic Info/)).toBeInTheDocument()
      expect(screen.getByText(/Metadata/)).toBeInTheDocument()
      expect(screen.getByText(/Publish Prep/)).toBeInTheDocument()
    })

    it("should switch to metadata tab when clicked", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Metadata"))

      await waitFor(() => {
        expect(screen.getByText("Author Info")).toBeInTheDocument()
      })
    })

    it("should switch to publish tab when clicked", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Publish Prep"))

      await waitFor(() => {
        expect(screen.getByText("Publish Readiness Check")).toBeInTheDocument()
      })
    })
  })

  describe("basic info tab", () => {
    it("should show category", () => {
      renderDialog()

      expect(screen.getByText("Productivity")).toBeInTheDocument()
    })

    it("should show tags", () => {
      renderDialog()

      expect(screen.getByText("test")).toBeInTheDocument()
      expect(screen.getByText("demo")).toBeInTheDocument()
    })

    it("should show creation and modification dates", () => {
      renderDialog()

      // Message keys may be overridden by merged translation files in tests,
      // so we assert a stable substring instead of an exact label.
      expect(screen.getByText(/Created/i)).toBeInTheDocument()
      expect(screen.getByText("Last Modified")).toBeInTheDocument()
    })
  })

  describe("metadata tab", () => {
    it("should show author information", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Metadata"))

      await waitFor(() => {
        expect(screen.getByText("Name: Test Author")).toBeInTheDocument()
        expect(screen.getByText("Email: test@example.com")).toBeInTheDocument()
        expect(screen.getByText("Website: https://example.com")).toBeInTheDocument()
      })
    })

    it('should show "No author info" when no author', async () => {
      renderDialog({
        app: createMockApp({ author: undefined }),
      })

      fireEvent.click(screen.getByText("Metadata"))

      await waitFor(() => {
        expect(screen.getByText("No author info")).toBeInTheDocument()
      })
    })

    it("should show statistics", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Metadata"))

      await waitFor(() => {
        expect(screen.getByText("100")).toBeInTheDocument() // views
        expect(screen.getByText("50")).toBeInTheDocument() // uses
        expect(screen.getByText("4.5")).toBeInTheDocument() // rating
        expect(screen.getByText("10")).toBeInTheDocument() // ratingCount
      })
    })

    it("should show template info", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Metadata"))

      await waitFor(() => {
        expect(screen.getByText("Template ID: template-1")).toBeInTheDocument()
        expect(screen.getByText("Template Name: Test Template")).toBeInTheDocument()
      })
    })
  })

  describe("publish tab", () => {
    it("should show check publish button", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Publish Prep"))

      await waitFor(() => {
        expect(screen.getByText("Check Publish Requirements")).toBeInTheDocument()
      })
    })

    it("should call onPreparePublish when check button clicked", async () => {
      const onPreparePublish = jest.fn(() => ({ valid: true, missing: [] }))
      renderDialog({ onPreparePublish })

      fireEvent.click(screen.getByText("Publish Prep"))

      await waitFor(() => {
        const checkButton = screen.getByText("Check Publish Requirements")
        fireEvent.click(checkButton)
      })

      expect(onPreparePublish).toHaveBeenCalledWith("test-app-1")
    })

    it("should show success message when valid", async () => {
      const onPreparePublish = jest.fn(() => ({ valid: true, missing: [] }))
      renderDialog({ onPreparePublish })

      fireEvent.click(screen.getByText("Publish Prep"))

      await waitFor(() => {
        const checkButton = screen.getByText("Check Publish Requirements")
        fireEvent.click(checkButton)
      })

      await waitFor(() => {
        expect(screen.getByText("App is ready to publish!")).toBeInTheDocument()
      })
    })

    it("should show missing fields when invalid", async () => {
      const onPreparePublish = jest.fn(() => ({
        valid: false,
        missing: ["description (at least 10 characters)", "thumbnail"],
      }))
      renderDialog({ onPreparePublish })

      fireEvent.click(screen.getByText("Publish Prep"))

      await waitFor(() => {
        const checkButton = screen.getByText("Check Publish Requirements")
        fireEvent.click(checkButton)
      })

      await waitFor(() => {
        expect(screen.getByText("The following information is required:")).toBeInTheDocument()
        expect(screen.getByText("description (at least 10 characters)")).toBeInTheDocument()
        expect(screen.getByText("thumbnail")).toBeInTheDocument()
      })
    })

    it("should show published status when app is published", async () => {
      renderDialog({
        app: createMockApp({
          isPublished: true,
          publishedAt: Date.now() - 86400000,
          storeId: "store-123",
        }),
      })

      fireEvent.click(screen.getByText("Publish Prep"))

      await waitFor(() => {
        expect(screen.getByText("Published")).toBeInTheDocument()
        expect(screen.getByText("Store ID: store-123")).toBeInTheDocument()
      })
    })
  })

  describe("editing", () => {
    it("should enter edit mode when edit button clicked", async () => {
      renderDialog()

      const editButton = screen.getByText(/Edit Info/)
      fireEvent.click(editButton)

      await waitFor(() => {
        expect(screen.getByText(/Cancel/)).toBeInTheDocument()
        expect(screen.getByText(/Save/)).toBeInTheDocument()
      })
    })

    it("should show input fields in edit mode", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Edit Info"))

      await waitFor(() => {
        expect(screen.getByPlaceholderText("App Name")).toBeInTheDocument()
        expect(screen.getByPlaceholderText("1.0.0")).toBeInTheDocument()
      })
    })

    it("should cancel edit mode", async () => {
      renderDialog()

      fireEvent.click(screen.getByText("Edit Info"))

      await waitFor(() => {
        fireEvent.click(screen.getByText("Cancel"))
      })

      await waitFor(() => {
        expect(screen.getByText("Edit Info")).toBeInTheDocument()
      })
    })

    it("should call onSave when save is clicked", async () => {
      const onSave = jest.fn()
      renderDialog({ onSave })

      fireEvent.click(screen.getByText(/Edit Info/))

      await waitFor(() => {
        const nameInput = screen.getByPlaceholderText("App Name")
        fireEvent.change(nameInput, { target: { value: "Updated Name" } })
      })

      fireEvent.click(screen.getByText(/Save/))

      expect(onSave).toHaveBeenCalledWith(
        "test-app-1",
        expect.objectContaining({
          name: "Updated Name",
        })
      )
    })
  })

  describe("thumbnail", () => {
    it("should show thumbnail when set", () => {
      renderDialog({
        app: createMockApp({ thumbnail: "data:image/png;base64,test" }),
      })

      const img = screen.getByRole("img")
      expect(img).toHaveAttribute("src", "data:image/png;base64,test")
    })

    it("should call onGenerateThumbnail when refresh button clicked", async () => {
      const onGenerateThumbnail = jest.fn()
      renderDialog({ onGenerateThumbnail })

      const refreshButton = screen.getByText("Refresh Thumbnail")
      fireEvent.click(refreshButton)

      expect(onGenerateThumbnail).toHaveBeenCalledWith("test-app-1")
    })
  })

  describe("dialog controls", () => {
    it("should call onOpenChange when close button clicked", () => {
      const onOpenChange = jest.fn()
      renderDialog({ onOpenChange })

      const closeButton = screen.getByText("Close")
      fireEvent.click(closeButton)

      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it("should call onOpenChange with false when closing", async () => {
      const onOpenChange = jest.fn()
      renderDialog({ onOpenChange })

      // Enter edit mode
      fireEvent.click(screen.getByText("Edit Info"))

      // Click cancel to exit edit mode
      await waitFor(() => {
        fireEvent.click(screen.getByText("Cancel"))
      })

      // Click close button
      await waitFor(() => {
        fireEvent.click(screen.getByText("Close"))
      })

      // onOpenChange should have been called with false
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
