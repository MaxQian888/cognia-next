/**
 * A2UI Image Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIImage } from "./a2ui-image"
import type { A2UIImageComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

// Mock next/image
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    unoptimized: _unoptimized,
    fill: _fill,
    priority: _priority,
    quality: _quality,
    sizes: _sizes,
    placeholder: _placeholder,
    blurDataURL: _blurDataURL,
    loader: _loader,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & {
    unoptimized?: boolean
    fill?: boolean
    priority?: boolean
    quality?: number
    sizes?: string
    placeholder?: "blur" | "empty"
    blurDataURL?: string
    loader?: unknown
  }) => <img {...props} alt={props.alt || ""} />,
}))

describe("A2UIImage", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UIImageComponent): A2UIComponentProps<A2UIImageComponent> => ({
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

  it("should render an image with src", () => {
    const component: A2UIImageComponent = {
      id: "img-1",
      component: "Image",
      src: "https://example.com/image.jpg",
      alt: "Test Image",
    }

    render(<A2UIImage {...createProps(component)} />)
    const img = screen.getByRole("img")
    expect(img).toHaveAttribute("src", "https://example.com/image.jpg")
    expect(img).toHaveAttribute("alt", "Test Image")
  })

  it("should show fallback icon when no src provided", () => {
    const component: A2UIImageComponent = {
      id: "img-2",
      component: "Image",
      src: "",
    }

    const { container } = render(<A2UIImage {...createProps(component)} />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIImageComponent = {
      id: "img-3",
      component: "Image",
      src: "https://example.com/image.jpg",
      alt: "Test",
      className: "custom-class",
    }

    render(<A2UIImage {...createProps(component)} />)
    expect(screen.getByRole("img")).toHaveClass("custom-class")
  })
})
