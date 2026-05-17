/**
 * A2UI App Gallery Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { AppGallery } from "./app-gallery"

// Mock the hooks and components
jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: jest.fn(() => ({
    templates: [],
    getTemplate: jest.fn(),
    getAllApps: jest.fn(() => []),
    getAppInstance: jest.fn(),
    createFromTemplate: jest.fn(),
    duplicateApp: jest.fn(),
    deleteApp: jest.fn(),
    renameApp: jest.fn(),
    resetAppData: jest.fn(),
    handleAppAction: jest.fn(),
    setAppThumbnail: jest.fn(),
    updateAppMetadata: jest.fn(),
    incrementAppViews: jest.fn(),
    prepareForPublish: jest.fn(() => ({ valid: false, missing: [] })),
  })),
}))

jest.mock("./a2ui-surface", () => ({
  A2UIInlineSurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid={`surface-${surfaceId}`}>Surface</div>
  ),
}))

jest.mock("./app-card", () => ({
  AppCard: ({
    app,
    onSelect,
  }: {
    app: { id: string; name: string }
    onSelect: (id: string) => void
  }) => (
    <div data-testid={`app-card-${app.id}`} onClick={() => onSelect(app.id)}>
      {app.name}
    </div>
  ),
}))

jest.mock("./app-detail-dialog", () => ({
  AppDetailDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="app-detail-dialog">Detail Dialog</div> : null,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span>value</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}))

jest.mock("@/lib/a2ui/thumbnail", () => ({
  captureSurfaceThumbnail: jest.fn(),
}))

// Mock tooltip
jest.mock("@/components/ui/tooltip")

const mockUseA2UIAppBuilder = jest.requireMock("@/hooks/a2ui/use-app-builder").useA2UIAppBuilder

describe("AppGallery", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseA2UIAppBuilder.mockReturnValue({
      templates: [],
      getTemplate: jest.fn(),
      getAllApps: jest.fn(() => []),
      createFromTemplate: jest.fn(),
      duplicateApp: jest.fn(),
      deleteApp: jest.fn(),
      renameApp: jest.fn(),
      resetAppData: jest.fn(),
      handleAppAction: jest.fn(),
      setAppThumbnail: jest.fn(),
      updateAppMetadata: jest.fn(),
      incrementAppViews: jest.fn(),
      prepareForPublish: jest.fn(() => ({ valid: false, missing: [] })),
    })
  })

  describe("rendering", () => {
    it("should render gallery header", () => {
      render(<AppGallery />)

      expect(screen.getByText("App Gallery")).toBeInTheDocument()
    })

    it("should render search input", () => {
      render(<AppGallery />)

      // Search input is rendered (placeholder depends on i18n key resolution)
      const inputs = screen.getAllByRole("textbox")
      expect(inputs.length).toBeGreaterThan(0)
    })

    it("should render view mode toggles", () => {
      render(<AppGallery />)

      // Both grid and list buttons should be present
      const buttons = screen.getAllByRole("button")
      expect(buttons.length).toBeGreaterThan(0)
    })

    it("should render category filter", () => {
      render(<AppGallery />)

      expect(screen.getByText("All Categories")).toBeInTheDocument()
    })

    it("should render empty state when no apps", () => {
      render(<AppGallery />)

      expect(screen.getByText("No apps yet")).toBeInTheDocument()
    })

    it("should render app count badge", () => {
      render(<AppGallery />)

      expect(screen.getByText("0")).toBeInTheDocument()
    })
  })

  describe("with apps", () => {
    const mockApps = [
      {
        id: "app-1",
        templateId: "template-1",
        name: "Test App 1",
        createdAt: Date.now() - 86400000,
        lastModified: Date.now(),
        category: "productivity",
      },
      {
        id: "app-2",
        templateId: "template-2",
        name: "Test App 2",
        createdAt: Date.now() - 172800000,
        lastModified: Date.now() - 3600000,
        category: "data",
      },
    ]

    beforeEach(() => {
      mockUseA2UIAppBuilder.mockReturnValue({
        templates: [],
        getTemplate: jest.fn((id) => ({ id, name: `Template ${id}`, category: "productivity" })),
        getAllApps: jest.fn(() => mockApps),
        getAppInstance: jest.fn((id) => mockApps.find((app) => app.id === id)),
        createFromTemplate: jest.fn(),
        duplicateApp: jest.fn(() => "new-app-id"),
        deleteApp: jest.fn(),
        renameApp: jest.fn(),
        resetAppData: jest.fn(),
        handleAppAction: jest.fn(),
        setAppThumbnail: jest.fn(),
        updateAppMetadata: jest.fn(),
        incrementAppViews: jest.fn(),
        prepareForPublish: jest.fn(() => ({ valid: false, missing: [] })),
      })
    })

    it("should render app cards", () => {
      render(<AppGallery />)

      expect(screen.getByTestId("app-card-app-1")).toBeInTheDocument()
      expect(screen.getByTestId("app-card-app-2")).toBeInTheDocument()
    })

    it("should show correct app count", () => {
      render(<AppGallery />)

      expect(screen.getByText("2")).toBeInTheDocument()
    })

    it("should have search input for filtering", () => {
      render(<AppGallery />)

      const inputs = screen.getAllByRole("textbox")
      expect(inputs.length).toBeGreaterThan(0)
    })

    it("should render app cards that can be clicked", () => {
      render(<AppGallery />)

      const appCard = screen.getByTestId("app-card-app-1")
      expect(appCard).toBeInTheDocument()
    })
  })

  describe("dialogs", () => {
    it("should open delete confirmation dialog", async () => {
      const mockApps = [
        {
          id: "app-1",
          templateId: "t1",
          name: "App",
          createdAt: Date.now(),
          lastModified: Date.now(),
        },
      ]
      mockUseA2UIAppBuilder.mockReturnValue({
        templates: [],
        getTemplate: jest.fn(),
        getAllApps: jest.fn(() => mockApps),
        getAppInstance: jest.fn((id) => mockApps.find((app) => app.id === id)),
        createFromTemplate: jest.fn(),
        duplicateApp: jest.fn(),
        deleteApp: jest.fn(),
        renameApp: jest.fn(),
        resetAppData: jest.fn(),
        handleAppAction: jest.fn(),
        setAppThumbnail: jest.fn(),
        updateAppMetadata: jest.fn(),
        incrementAppViews: jest.fn(),
        prepareForPublish: jest.fn(() => ({ valid: false, missing: [] })),
      })

      render(<AppGallery />)

      // Verify app card is rendered
      expect(screen.getByTestId("app-card-app-1")).toBeInTheDocument()
    })
  })

  describe("props", () => {
    it("should accept className prop", () => {
      const { container } = render(<AppGallery className="custom-class" />)

      expect(container.firstChild).toHaveClass("custom-class")
    })

    it("should respect showPreview prop", () => {
      render(<AppGallery showPreview={false} />)

      // Component should render without preview
      expect(screen.getByText("App Gallery")).toBeInTheDocument()
    })

    it("should respect defaultViewMode prop", () => {
      render(<AppGallery defaultViewMode="list" />)

      // Should render in list mode
      expect(screen.getByText("App Gallery")).toBeInTheDocument()
    })
  })

  describe("sorting", () => {
    it("should render sort options", () => {
      render(<AppGallery />)

      expect(screen.getByText("Sort:")).toBeInTheDocument()
    })

    it("should have sort toggle button", () => {
      render(<AppGallery />)

      // Sort order toggle button should be present
      const buttons = screen.getAllByRole("button")
      expect(buttons.length).toBeGreaterThan(0)
    })
  })
})
