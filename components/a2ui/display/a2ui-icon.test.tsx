/**
 * A2UI Icon Component Tests
 */

import React from "react"
import { render } from "@testing-library/react"
import { A2UIIcon } from "./a2ui-icon"
import type { A2UIIconComponent, A2UIComponentProps } from "@/types/a2ui/schema"

describe("A2UIIcon", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIIconComponent): A2UIComponentProps<A2UIIconComponent> => ({
    component,
    surfaceId: "test-surface",
    dataModel: {},
    onAction: mockOnAction,
    onDataChange: mockOnDataChange,
    renderChild: mockRenderChild,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render an icon by name", () => {
    const component: A2UIIconComponent = {
      id: "icon-1",
      component: "Icon",
      name: "check",
    }

    const { container } = render(<A2UIIcon {...createProps(component)} />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("should preserve an icon name that is already PascalCase", () => {
    const component: A2UIIconComponent = {
      id: "icon-pascal-case",
      component: "Icon",
      name: "FileText",
    }

    const { container } = render(<A2UIIcon {...createProps(component)} />)
    expect(container.querySelector("svg")).toHaveClass("lucide-file-text")
  })

  it.each([
    ["file_text", "lucide-file-text"],
    ["CHECK", "lucide-check"],
  ])("should keep normalizing the legacy %s spelling", (name, expectedClass) => {
    const component: A2UIIconComponent = {
      id: `icon-${name}`,
      component: "Icon",
      name,
    }

    const { container } = render(<A2UIIcon {...createProps(component)} />)
    expect(container.querySelector("svg")).toHaveClass(expectedClass)
  })

  it("should render fallback icon for unknown name", () => {
    const component: A2UIIconComponent = {
      id: "icon-2",
      component: "Icon",
      name: "unknown-icon-name-xyz",
    }

    const { container } = render(<A2UIIcon {...createProps(component)} />)
    // Should render HelpCircle as fallback
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("should apply custom size", () => {
    const component: A2UIIconComponent = {
      id: "icon-3",
      component: "Icon",
      name: "star",
      size: 32,
    }

    const { container } = render(<A2UIIcon {...createProps(component)} />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("width", "32")
    expect(svg).toHaveAttribute("height", "32")
  })

  it("should apply custom className", () => {
    const component: A2UIIconComponent = {
      id: "icon-4",
      component: "Icon",
      name: "heart",
      className: "custom-class",
    }

    const { container } = render(<A2UIIcon {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })
})
