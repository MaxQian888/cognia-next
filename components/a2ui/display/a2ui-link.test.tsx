/**
 * A2UI Link Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UILink } from "./a2ui-link"
import type { A2UILinkComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataCtx = {
  surface: null,
  dataModel: {},
  components: {},
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
  resolveNumber: (value: number | { path: string }) => (typeof value === "number" ? value : 0),
  resolveBoolean: (value: boolean | { path: string }) =>
    typeof value === "boolean" ? value : false,
  resolveArray: <T,>(value: T[] | { path: string }, d: T[] = []) =>
    Array.isArray(value) ? value : d,
}
jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({ ...mockDataCtx }),
  useA2UIData: () => mockDataCtx,
  useA2UIActions: () => ({
    surfaceId: "test-surface",
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    getBindingPath: jest.fn(),
    getComponent: jest.fn(),
    renderChild: jest.fn(),
  }),
}))

describe("A2UILink", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UILinkComponent): A2UIComponentProps<A2UILinkComponent> => ({
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

  it("should render a link with text", () => {
    const component: A2UILinkComponent = {
      id: "link-1",
      component: "Link",
      text: "Click here",
      href: "https://example.com",
    }

    render(<A2UILink {...createProps(component)} />)
    expect(screen.getByText("Click here")).toBeInTheDocument()
  })

  it("should have correct href attribute", () => {
    const component: A2UILinkComponent = {
      id: "link-2",
      component: "Link",
      text: "Visit",
      href: "https://example.com",
    }

    render(<A2UILink {...createProps(component)} />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com")
  })

  it("should open external links in new tab", () => {
    const component: A2UILinkComponent = {
      id: "link-3",
      component: "Link",
      text: "External",
      href: "https://example.com",
      external: true,
    }

    render(<A2UILink {...createProps(component)} />)
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })

  it("should call onAction when action is provided", () => {
    const component: A2UILinkComponent = {
      id: "link-4",
      component: "Link",
      text: "Action Link",
      action: "navigate",
    }

    render(<A2UILink {...createProps(component)} />)
    fireEvent.click(screen.getByText("Action Link"))

    expect(mockOnAction).toHaveBeenCalledWith("navigate", expect.any(Object))
  })

  it("should apply custom className", () => {
    const component: A2UILinkComponent = {
      id: "link-5",
      component: "Link",
      text: "Styled Link",
      href: "#",
      className: "custom-class",
    }

    render(<A2UILink {...createProps(component)} />)
    expect(screen.getByRole("link")).toHaveClass("custom-class")
  })
})
