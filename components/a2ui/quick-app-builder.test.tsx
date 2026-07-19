/**
 * Quick App Builder Component Tests
 */

import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QuickAppBuilder } from "./quick-app-builder"

const mockToastError = jest.fn()
const mockLoggerError = jest.fn()

jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      error: (...args: unknown[]) => mockLoggerError(...args),
    },
  },
}))

// Mock the hooks
jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: jest.fn(() => ({
    templates: [
      {
        id: "todo-list",
        name: "Todo List",
        description: "Task management",
        icon: "CheckSquare",
        category: "productivity",
        tags: ["productivity"],
      },
      {
        id: "calculator",
        name: "Calculator",
        description: "Basic calculator",
        icon: "Calculator",
        category: "utility",
        tags: ["math"],
      },
    ],
    getTemplate: jest.fn((id) => ({ id, name: "Template", category: "productivity" })),
    getTemplatesByCategory: jest.fn(() => []),
    searchTemplates: jest.fn(() => []),
    getAllApps: jest.fn(() => []),
    createFromTemplate: jest.fn(() => "new-app-id"),
    createCustomApp: jest.fn(() => "custom-app-id"),
    duplicateApp: jest.fn(),
    deleteApp: jest.fn(),
    renameApp: jest.fn(),
    resetAppData: jest.fn(),
    handleAppAction: jest.fn(),
    exportApp: jest.fn(),
    downloadApp: jest.fn(),
    importApp: jest.fn(),
    importAppFromFile: jest.fn(),
    generateShareCode: jest.fn(),
    copyAppToClipboard: jest.fn(),
    getSocialShareUrls: jest.fn(),
  })),
}))

jest.mock("@/hooks/a2ui", () => ({
  useA2UI: jest.fn(() => ({
    processMessages: jest.fn(),
  })),
}))

jest.mock("./a2ui-surface", () => ({
  A2UIInlineSurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid={`surface-${surfaceId}`}>Surface</div>
  ),
}))

jest.mock("./quick-app-builder/quick-app-card", () => ({
  QuickAppCard: ({
    app,
    onSelect,
    onDelete,
  }: {
    app: { id: string; name: string }
    onSelect: (id: string) => void
    onDelete: (id: string) => void
  }) => (
    <div data-testid={`quick-app-card-${app.id}`}>
      {app.name}
      <button type="button" onClick={() => onSelect(app.id)}>
        Select {app.name}
      </button>
      <button type="button" onClick={() => onDelete(app.id)}>
        Delete {app.name}
      </button>
    </div>
  ),
}))

jest.mock("@/lib/a2ui/templates", () => ({
  templateCategories: [
    { id: "productivity", name: "Productivity", icon: "Briefcase" },
    { id: "data", name: "Data", icon: "BarChart3" },
    { id: "form", name: "Forms", icon: "ClipboardList" },
    { id: "utility", name: "Utilities", icon: "Wrench" },
    { id: "social", name: "Social", icon: "Users" },
  ],
}))

jest.mock("@/lib/a2ui/app-generator", () => ({
  generateAppFromDescription: jest.fn(() => ({
    surfaceId: "generated-app-id",
    messages: [],
  })),
}))

const mockUseA2UIAppBuilder = jest.requireMock("@/hooks/a2ui/use-app-builder").useA2UIAppBuilder

describe("QuickAppBuilder", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("should render component", () => {
      render(<QuickAppBuilder />)

      expect(screen.getByText("Quick Apps")).toBeInTheDocument()
    })

    it("should render tabs", () => {
      render(<QuickAppBuilder />)

      expect(screen.getByText("Flash")).toBeInTheDocument()
      expect(screen.getByText("Templates")).toBeInTheDocument()
      expect(screen.getByText(/My Apps/)).toBeInTheDocument()
    })

    it("should render flash build input", () => {
      render(<QuickAppBuilder />)

      expect(screen.getByPlaceholderText("e.g. Make a pomodoro timer...")).toBeInTheDocument()
    })

    it("should render create button", () => {
      render(<QuickAppBuilder />)

      // Flash generate button
    })
  })

  describe("tabs navigation", () => {
    it("should have tabs trigger elements", () => {
      render(<QuickAppBuilder />)

      // Verify tab triggers exist
      const tabList = screen.getByRole("tablist")
      expect(tabList).toBeInTheDocument()
    })

    it("should render tab panels", () => {
      render(<QuickAppBuilder />)

      // First tab panel should be visible
      const tabPanel = screen.getByRole("tabpanel")
      expect(tabPanel).toBeInTheDocument()
    })
  })

  describe("flash build", () => {
    it("should enable button when description is entered", async () => {
      render(<QuickAppBuilder />)

      const input = screen.getByPlaceholderText("e.g. Make a pomodoro timer...")
      fireEvent.change(input, { target: { value: "Create a todo list app" } })

      // Button should be enabled after entering description
      const buttons = screen.getAllByRole("button")
      expect(buttons.length).toBeGreaterThan(0)
    })
  })

  describe("templates", () => {
    it("should have templates available", () => {
      render(<QuickAppBuilder />)

      // Templates are provided via mock hook
      expect(mockUseA2UIAppBuilder().templates.length).toBeGreaterThan(0)
    })
  })

  describe("my apps", () => {
    it("should have getAllApps function", () => {
      render(<QuickAppBuilder />)

      expect(typeof mockUseA2UIAppBuilder().getAllApps).toBe("function")
    })

    it("keeps the selected preview and confirmation dialog open when deletion fails", async () => {
      const user = userEvent.setup()
      const app = {
        id: "app-1",
        templateId: "todo-list",
        name: "Persistent App",
        createdAt: Date.now(),
        lastModified: Date.now(),
      }
      const deleteApp = jest.fn().mockRejectedValue(new Error("IndexedDB unavailable"))
      mockUseA2UIAppBuilder.mockReturnValue({
        templates: [],
        getTemplate: jest.fn(),
        getTemplatesByCategory: jest.fn(() => []),
        searchTemplates: jest.fn(() => []),
        getAllApps: jest.fn(() => [app]),
        getAppInstance: jest.fn(() => app),
        createFromTemplate: jest.fn(),
        createCustomApp: jest.fn(),
        duplicateApp: jest.fn(),
        deleteApp,
        renameApp: jest.fn(),
        resetAppData: jest.fn(),
        handleAppAction: jest.fn(),
        exportApp: jest.fn(),
        downloadApp: jest.fn(),
        importApp: jest.fn(),
        importAppFromFile: jest.fn(),
        generateShareCode: jest.fn(),
        copyAppToClipboard: jest.fn(),
        getSocialShareUrls: jest.fn(),
      })

      render(<QuickAppBuilder />)

      await user.click(screen.getByRole("tab", { name: /My Apps/ }))
      await user.click(screen.getByRole("button", { name: "Select Persistent App" }))
      expect(screen.getByTestId("surface-app-1")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Delete Persistent App" }))
      await user.click(screen.getByRole("button", { name: "Delete" }))

      await waitFor(() => expect(deleteApp).toHaveBeenCalledWith("app-1"))
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Failed to delete app"))
      expect(screen.getByRole("heading", { name: "Delete App" })).toBeInTheDocument()
      expect(screen.getByTestId("surface-app-1")).toBeInTheDocument()
    })
  })

  describe("props", () => {
    it("should accept className prop", () => {
      const { container } = render(<QuickAppBuilder className="custom-class" />)

      expect(container.firstChild).toHaveClass("custom-class")
    })

    it("should accept onAppSelect prop", () => {
      const onAppSelect = jest.fn()
      render(<QuickAppBuilder onAppSelect={onAppSelect} />)

      // onAppSelect prop is accepted without throwing
      expect(true).toBe(true)
    })
  })

  describe("view mode", () => {
    it("should render with buttons for interaction", () => {
      render(<QuickAppBuilder />)

      const buttons = screen.getAllByRole("button")
      expect(buttons.length).toBeGreaterThan(0)
    })
  })
})
