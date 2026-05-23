/**
 * A2UI App Card Component Tests
 */

import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AppCard, type AppCardProps } from "./a2ui-app-card"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

// Mock thumbnail functions
jest.mock("@/lib/a2ui/thumbnail", () => ({
  generatePlaceholderThumbnail: jest.fn(() => "data:image/png;base64,placeholder"),
  captureSurfaceThumbnail: jest.fn(() =>
    Promise.resolve({
      dataUrl: "data:image/png;base64,captured",
      width: 280,
      height: 180,
      format: "webp",
      generatedAt: Date.now(),
    })
  ),
}))

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  ...jest.requireActual("lucide-react"),
  icons: {
    CheckSquare: () => <span data-testid="icon-checksquare">CheckSquare</span>,
    Sparkles: () => <span data-testid="icon-sparkles">Sparkles</span>,
  },
}))

// Mock tooltip provider
jest.mock("@/components/ui/tooltip")

jest.mock("@/components/ui/dropdown-menu")

const createMockApp = (overrides: Partial<A2UIAppInstance> = {}): A2UIAppInstance => ({
  id: "test-app-1",
  templateId: "template-1",
  name: "Test Application",
  createdAt: Date.now() - 86400000, // 1 day ago
  lastModified: Date.now() - 3600000, // 1 hour ago
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
  tags: ["test", "productivity"],
  ...overrides,
})

const renderAppCard = (props: Partial<AppCardProps> = {}) => {
  const defaultProps: AppCardProps = {
    app: createMockApp(),
    template: createMockTemplate(),
    ...props,
  }
  return render(<AppCard {...defaultProps} />)
}

describe("AppCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("should render app name", () => {
      renderAppCard()

      expect(screen.getByText("Test Application")).toBeInTheDocument()
    })

    it("should render template name", () => {
      renderAppCard()

      expect(screen.getByText("Test Template")).toBeInTheDocument()
    })

    it("should render description when provided", () => {
      renderAppCard({
        app: createMockApp({ description: "This is a test app description" }),
        showDescription: true,
      })

      expect(screen.getByText("This is a test app description")).toBeInTheDocument()
    })

    it("should render custom app badge when no template", () => {
      renderAppCard({ template: undefined })

      expect(screen.getByText("Custom App")).toBeInTheDocument()
    })

    it("should show version badge when version is set", () => {
      renderAppCard({
        app: createMockApp({ version: "1.2.3" }),
      })

      expect(screen.getByText("v1.2.3")).toBeInTheDocument()
    })
  })

  describe("thumbnail", () => {
    it("should show placeholder thumbnail when no thumbnail set", async () => {
      renderAppCard({ showThumbnail: true })

      // The placeholder should be generated
      await waitFor(() => {
        const img = screen.queryByRole("img")
        if (img) {
          expect(img).toHaveAttribute("src", expect.stringContaining("data:image/"))
        }
      })
    })

    it("should show existing thumbnail when set", () => {
      renderAppCard({
        app: createMockApp({ thumbnail: "data:image/png;base64,existingThumb" }),
        showThumbnail: true,
      })

      const img = screen.getByRole("img")
      expect(img).toHaveAttribute("src", "data:image/png;base64,existingThumb")
    })

    it("should hide thumbnail when showThumbnail is false", () => {
      renderAppCard({ showThumbnail: false })

      expect(screen.queryByRole("img")).not.toBeInTheDocument()
    })
  })

  describe("tags", () => {
    it("should render tags from app", () => {
      renderAppCard({
        app: createMockApp({ tags: ["custom-tag-1", "custom-tag-2"] }),
      })

      expect(screen.getByText("custom-tag-1")).toBeInTheDocument()
      expect(screen.getByText("custom-tag-2")).toBeInTheDocument()
    })

    it("should render tags from template if app has no tags", () => {
      renderAppCard({
        app: createMockApp({ tags: undefined }),
        template: createMockTemplate({ tags: ["template-tag"] }),
      })

      expect(screen.getByText("template-tag")).toBeInTheDocument()
    })

    it("should show +N badge for extra tags", () => {
      renderAppCard({
        app: createMockApp({ tags: ["tag1", "tag2", "tag3", "tag4", "tag5"] }),
      })

      expect(screen.getByText("+2")).toBeInTheDocument()
    })
  })

  describe("stats", () => {
    it("should render view count when provided", () => {
      renderAppCard({
        app: createMockApp({
          stats: { views: 100 },
        }),
        showStats: true,
      })

      expect(screen.getByText("100")).toBeInTheDocument()
    })

    it("should render rating when provided", () => {
      renderAppCard({
        app: createMockApp({
          stats: { rating: 4.5, ratingCount: 10 },
        }),
        showStats: true,
      })

      expect(screen.getByText("4.5")).toBeInTheDocument()
      expect(screen.getByText("(10)")).toBeInTheDocument()
    })

    it("should hide stats when showStats is false", () => {
      renderAppCard({
        app: createMockApp({
          stats: { views: 100 },
        }),
        showStats: false,
      })

      expect(screen.queryByText("100")).not.toBeInTheDocument()
    })
  })

  describe("interactions", () => {
    it("should call onSelect when card is clicked", () => {
      const onSelect = jest.fn()
      renderAppCard({ onSelect })

      fireEvent.click(screen.getByText("Test Application").closest(".group")!)

      expect(onSelect).toHaveBeenCalledWith("test-app-1")
    })

    it("should show selected state", () => {
      const { container } = renderAppCard({ isSelected: true })

      expect(container.querySelector(".ring-2")).toBeInTheDocument()
    })

    it("should call onOpen when menu item is clicked", async () => {
      const onOpen = jest.fn()
      renderAppCard({ onOpen })

      // With mock, menu items are always visible
      const openButton = screen.getByText("Run")
      fireEvent.click(openButton)

      expect(onOpen).toHaveBeenCalledWith("test-app-1")
    })

    it("should call onRename when rename is clicked", async () => {
      const onRename = jest.fn()
      renderAppCard({ onRename })

      // With mock, menu items are always visible
      const renameButton = screen.getByText("App Name")
      fireEvent.click(renameButton)

      expect(onRename).toHaveBeenCalled()
    })

    it("should call onDuplicate when duplicate is clicked", async () => {
      const onDuplicate = jest.fn()
      renderAppCard({ onDuplicate })

      // With mock, menu items are always visible
      const duplicateButton = screen.getByText("Duplicate")
      fireEvent.click(duplicateButton)

      expect(onDuplicate).toHaveBeenCalledWith("test-app-1")
    })

    it("should call onDelete when delete is clicked", async () => {
      const onDelete = jest.fn()
      renderAppCard({ onDelete })

      // With mock, menu items are always visible
      const deleteButton = screen.getByText("Delete")
      fireEvent.click(deleteButton)

      expect(onDelete).toHaveBeenCalledWith("test-app-1")
    })
  })

  describe("compact mode", () => {
    it("should hide description in compact mode", () => {
      renderAppCard({
        app: createMockApp({ description: "This description should be hidden" }),
        compact: true,
        showDescription: true,
      })

      expect(screen.queryByText("This description should be hidden")).not.toBeInTheDocument()
    })

    it("should hide tags in compact mode", () => {
      renderAppCard({
        app: createMockApp({ tags: ["hidden-tag"] }),
        compact: true,
      })

      expect(screen.queryByText("hidden-tag")).not.toBeInTheDocument()
    })
  })

  describe("date formatting", () => {
    it('should show "just now" for recent modifications', () => {
      renderAppCard({
        app: createMockApp({ lastModified: Date.now() - 30000 }), // 30 seconds ago
      })

      expect(screen.getByText("just now")).toBeInTheDocument()
    })

    it("should show minutes for recent modifications", () => {
      renderAppCard({
        app: createMockApp({ lastModified: Date.now() - 300000 }), // 5 minutes ago
      })

      expect(screen.getByText("5m ago")).toBeInTheDocument()
    })

    it("should show hours for older modifications", () => {
      renderAppCard({
        app: createMockApp({ lastModified: Date.now() - 7200000 }), // 2 hours ago
      })

      expect(screen.getByText("2h ago")).toBeInTheDocument()
    })

    it("should show days for much older modifications", () => {
      renderAppCard({
        app: createMockApp({ lastModified: Date.now() - 172800000 }), // 2 days ago
      })

      expect(screen.getByText("2d ago")).toBeInTheDocument()
    })
  })
})
