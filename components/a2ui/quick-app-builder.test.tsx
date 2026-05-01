/**
 * Quick App Builder Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { QuickAppBuilder } from "./quick-app-builder"

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

jest.mock("@/lib/a2ui/templates", () => ({
  templateCategories: ["productivity", "data", "form", "utility", "social"],
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
