/**
 * A2UI Animation Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIAnimation } from "./a2ui-animation"
import type { A2UIAnimationComponentDef } from "@/types/a2ui/animation"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

// Mock motion/react
jest.mock("motion/react", () => ({
  motion: {
    div: ({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div className={className} data-testid="motion-div" {...props}>
        {children}
      </div>
    ),
  },
  useReducedMotion: jest.fn(() => false),
}))

// Mock the A2UI context
jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    dataModel: {},
    resolveString: (value: string | { path: string }) => (typeof value === "string" ? value : ""),
  }),
}))

describe("A2UIAnimation", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn((id: string) => <div data-testid={`child-${id}`}>{id}</div>)

  const createProps = (
    component: A2UIAnimationComponentDef
  ): A2UIComponentProps<A2UIAnimationComponentDef> => ({
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

  it("should render with fadeIn animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-1",
      component: "Animation",
      type: "fadeIn",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
    expect(screen.getByTestId("child-child-1")).toBeInTheDocument()
  })

  it("should render with slideIn animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-2",
      component: "Animation",
      type: "slideIn",
      direction: "up",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should render with bounce animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-3",
      component: "Animation",
      type: "bounce",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should render with pulse animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-4",
      component: "Animation",
      type: "pulse",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should render with shake animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-5",
      component: "Animation",
      type: "shake",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should render with scale animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-6",
      component: "Animation",
      type: "scale",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should render with none animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-7",
      component: "Animation",
      type: "none",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should render multiple children", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-8",
      component: "Animation",
      type: "fadeIn",
      children: ["child-1", "child-2", "child-3"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("child-child-1")).toBeInTheDocument()
    expect(screen.getByTestId("child-child-2")).toBeInTheDocument()
    expect(screen.getByTestId("child-child-3")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-9",
      component: "Animation",
      type: "fadeIn",
      className: "custom-animation",
      children: [],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    const motionDiv = screen.getByTestId("motion-div")
    expect(motionDiv).toHaveClass("custom-animation")
  })

  it("should handle custom animation configuration", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-10",
      component: "Animation",
      type: "fadeIn",
      customAnimation: {
        initial: { opacity: 0, scale: 0.5 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0 },
        transition: { duration: 1 },
      },
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle delay and duration props", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-11",
      component: "Animation",
      type: "fadeIn",
      duration: 1.5,
      delay: 0.5,
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle repeat prop", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-12",
      component: "Animation",
      type: "pulse",
      repeat: 3,
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle infinite repeat", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-13",
      component: "Animation",
      type: "pulse",
      repeat: "infinite",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle slideIn with different directions", () => {
    const directions: Array<"up" | "down" | "left" | "right"> = ["up", "down", "left", "right"]

    directions.forEach((direction) => {
      const component: A2UIAnimationComponentDef = {
        id: `anim-slide-${direction}`,
        component: "Animation",
        type: "slideIn",
        direction,
        children: ["child-1"],
      }

      const { unmount } = render(<A2UIAnimation {...createProps(component)} />)
      expect(screen.getByTestId("motion-div")).toBeInTheDocument()
      unmount()
    })
  })

  it("should render empty when no children", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-14",
      component: "Animation",
      type: "fadeIn",
      children: undefined,
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle highlight animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-15",
      component: "Animation",
      type: "highlight",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle fadeOut animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-16",
      component: "Animation",
      type: "fadeOut",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })

  it("should handle slideOut animation type", () => {
    const component: A2UIAnimationComponentDef = {
      id: "anim-17",
      component: "Animation",
      type: "slideOut",
      direction: "down",
      children: ["child-1"],
    }

    render(<A2UIAnimation {...createProps(component)} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })
})

describe("A2UIAnimation with reduced motion", () => {
  const mockUseReducedMotion = jest.requireMock("motion/react").useReducedMotion

  beforeEach(() => {
    jest.clearAllMocks()
    mockUseReducedMotion.mockReturnValue(true)
  })

  afterEach(() => {
    mockUseReducedMotion.mockReturnValue(false)
  })

  it("should respect reduced motion preference", () => {
    const mockRenderChild = jest.fn((id: string) => <div data-testid={`child-${id}`}>{id}</div>)

    const component: A2UIAnimationComponentDef = {
      id: "anim-reduced",
      component: "Animation",
      type: "fadeIn",
      children: ["child-1"],
    }

    const props: A2UIComponentProps<A2UIAnimationComponentDef> = {
      component,
      surfaceId: "test-surface",
      dataModel: {},
      onAction: jest.fn(),
      onDataChange: jest.fn(),
      renderChild: mockRenderChild,
    }

    render(<A2UIAnimation {...props} />)
    expect(screen.getByTestId("motion-div")).toBeInTheDocument()
  })
})
