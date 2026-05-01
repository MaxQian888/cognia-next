/**
 * A2UI Text Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIText } from "./a2ui-text"
import type { A2UITextComponent, A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the A2UI context
const mockDataContext = {
  surface: null,
  dataModel: {},
  components: {},
  resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
  resolveNumber: (value: number | { path: string }) => (typeof value === "number" ? value : 0),
  resolveBoolean: (value: boolean | { path: string }) =>
    typeof value === "boolean" ? value : false,
  resolveArray: <T,>(value: T[] | { path: string }, defaultValue: T[] = []) =>
    Array.isArray(value) ? value : defaultValue,
}

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({ ...mockDataContext }),
  useA2UIData: () => mockDataContext,
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

describe("A2UIText", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UITextComponent): A2UIComponentProps<A2UITextComponent> => ({
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

  it("should render text content", () => {
    const component: A2UITextComponent = {
      id: "text-1",
      component: "Text",
      text: "Hello World",
    }

    render(<A2UIText {...createProps(component)} />)
    expect(screen.getByText("Hello World")).toBeInTheDocument()
  })

  it("should render with heading variant", () => {
    const component: A2UITextComponent = {
      id: "text-2",
      component: "Text",
      text: "Heading",
      variant: "heading1",
    }

    render(<A2UIText {...createProps(component)} />)
    const heading = screen.getByText("Heading")
    expect(heading).toBeInTheDocument()
  })

  it("should render with body variant", () => {
    const component: A2UITextComponent = {
      id: "text-3",
      component: "Text",
      text: "Body text",
      variant: "body",
    }

    render(<A2UIText {...createProps(component)} />)
    expect(screen.getByText("Body text")).toBeInTheDocument()
  })

  it("should render with code variant", () => {
    const component: A2UITextComponent = {
      id: "text-4",
      component: "Text",
      text: 'console.log("test")',
      variant: "code",
    }

    render(<A2UIText {...createProps(component)} />)
    const code = screen.getByText('console.log("test")')
    expect(code.tagName).toBe("CODE")
  })

  it("should apply custom className", () => {
    const component: A2UITextComponent = {
      id: "text-5",
      component: "Text",
      text: "Styled text",
      className: "custom-class",
    }

    const { container } = render(<A2UIText {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("custom-class")
  })

  it("should apply text alignment", () => {
    const component: A2UITextComponent = {
      id: "text-6",
      component: "Text",
      text: "Centered",
      align: "center",
    }

    const { container } = render(<A2UIText {...createProps(component)} />)
    expect(container.firstChild).toHaveClass("text-center")
  })
})
