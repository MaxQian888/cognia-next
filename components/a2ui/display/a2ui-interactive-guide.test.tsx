/**
 * A2UI Interactive Guide Component Tests
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UIInteractiveGuide } from "./a2ui-interactive-guide"
import type {
  A2UIInteractiveGuideComponentDef,
  A2UIGuideStep,
} from "@/types/a2ui/interactive-guide"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      guideTitle: "Guide",
      skipGuide: "Skip",
      previousStep: "Previous",
      nextStep: "Next",
      complete: "Complete",
      stepProgress: `Step ${params?.current || 1} of ${params?.total || 1}`,
    }
    return translations[key] || key
  },
}))

// Mock motion/react
jest.mock("motion/react", () => ({
  motion: {
    div: ({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div className={className} data-testid="motion-div" {...props}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: jest.fn(() => false),
}))

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
jest.mock("@/hooks/a2ui", () => ({
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

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Check: () => <span data-testid="icon-check" />,
  Target: () => <span data-testid="icon-target" />,
  X: () => <span data-testid="icon-x" />,
}))

describe("A2UIInteractiveGuide", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn((id: string) => <div data-testid={`child-${id}`}>{id}</div>)

  const createSteps = (): A2UIGuideStep[] => [
    {
      id: "step-1",
      title: "Step 1",
      description: "First step description",
      content: ["content-1"],
    },
    {
      id: "step-2",
      title: "Step 2",
      description: "Second step description",
      content: ["content-2"],
    },
    {
      id: "step-3",
      title: "Step 3",
      description: "Third step description",
      content: ["content-3"],
      isOptional: true,
    },
  ]

  const createProps = (
    component: A2UIInteractiveGuideComponentDef
  ): A2UIComponentProps<A2UIInteractiveGuideComponentDef> => ({
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

  it("should render with title and steps", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-1",
      component: "InteractiveGuide",
      title: "My Guide",
      steps: createSteps(),
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(screen.getByText("My Guide")).toBeInTheDocument()
    expect(screen.getByText("Step 1")).toBeInTheDocument()
    expect(screen.getByText("First step description")).toBeInTheDocument()
  })

  it("should render progress bar when showProgress is true", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-2",
      component: "InteractiveGuide",
      steps: createSteps(),
      showProgress: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument()
    expect(screen.getByText("33%")).toBeInTheDocument()
  })

  it("should navigate to next step", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-3",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)

    // Initially on step 1
    expect(screen.getByText("Step 1")).toBeInTheDocument()

    // Click next
    fireEvent.click(screen.getByText("Next"))

    // Should be on step 2
    expect(screen.getByText("Step 2")).toBeInTheDocument()
  })

  it("should navigate to previous step", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-4",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)

    // Go to step 2
    fireEvent.click(screen.getByText("Next"))
    expect(screen.getByText("Step 2")).toBeInTheDocument()

    // Go back to step 1
    fireEvent.click(screen.getByText("Previous"))
    expect(screen.getByText("Step 1")).toBeInTheDocument()
  })

  it("should disable previous button on first step", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-5",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    const previousButton = screen.getByText("Previous").closest("button")
    expect(previousButton).toBeDisabled()
  })

  it("should show Complete button on last step", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-6",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)

    // Navigate to last step
    fireEvent.click(screen.getByText("Next"))
    fireEvent.click(screen.getByText("Next"))

    expect(screen.getByText("Complete")).toBeInTheDocument()
  })

  it("should trigger onComplete action when completing guide", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-7",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
      onComplete: "guide_complete",
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)

    // Navigate to last step
    fireEvent.click(screen.getByText("Next"))
    fireEvent.click(screen.getByText("Next"))

    // Click complete
    fireEvent.click(screen.getByText("Complete"))

    expect(mockOnAction).toHaveBeenCalledWith("guide_complete", expect.any(Object))
  })

  it("should trigger onStepChange action when navigating", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-8",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
      onStepChange: "step_changed",
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    fireEvent.click(screen.getByText("Next"))

    expect(mockOnAction).toHaveBeenCalledWith("step_changed", {
      step: 1,
      stepId: "step-2",
    })
  })

  it("should show skip button when allowSkip is true", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-9",
      component: "InteractiveGuide",
      steps: createSteps(),
      allowSkip: true,
      onSkip: "guide_skipped",
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(screen.getByText("Skip")).toBeInTheDocument()
  })

  it("should trigger onSkip action when skipping", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-10",
      component: "InteractiveGuide",
      steps: createSteps(),
      allowSkip: true,
      onSkip: "guide_skipped",
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    fireEvent.click(screen.getByText("Skip"))

    expect(mockOnAction).toHaveBeenCalledWith("guide_skipped", { skippedAt: 0 })
  })

  it("should render step indicator dots", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-11",
      component: "InteractiveGuide",
      steps: createSteps(),
      showStepIndicator: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    const stepButtons = screen.getAllByRole("button", { name: /Go to step/ })
    expect(stepButtons.length).toBe(3)
  })

  it("should hide step indicator when showStepIndicator is false", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-12",
      component: "InteractiveGuide",
      steps: createSteps(),
      showStepIndicator: false,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    const stepButtons = screen.queryAllByRole("button", { name: /Go to step/ })
    expect(stepButtons.length).toBe(0)
  })

  it("should render Optional badge for optional steps", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-13",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)

    // Navigate to step 3 (optional)
    fireEvent.click(screen.getByText("Next"))
    fireEvent.click(screen.getByText("Next"))

    expect(screen.getByText("Optional")).toBeInTheDocument()
  })

  it("should render empty state when no steps", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-14",
      component: "InteractiveGuide",
      steps: [],
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(screen.getByText("No steps defined")).toBeInTheDocument()
  })

  it("should apply custom className", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-15",
      component: "InteractiveGuide",
      steps: createSteps(),
      className: "custom-guide",
    }

    const { container } = render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(container.querySelector(".custom-guide")).toBeInTheDocument()
  })

  it("should render child content for each step", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-16",
      component: "InteractiveGuide",
      steps: createSteps(),
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(mockRenderChild).toHaveBeenCalledWith("content-1")
    expect(screen.getByTestId("child-content-1")).toBeInTheDocument()
  })

  it("should trigger step action when step has action defined", () => {
    const stepsWithAction: A2UIGuideStep[] = [
      {
        id: "step-1",
        title: "Step 1",
        content: ["content-1"],
        action: "step_1_action",
      },
      {
        id: "step-2",
        title: "Step 2",
        content: ["content-2"],
        action: "step_2_action",
      },
    ]

    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-17",
      component: "InteractiveGuide",
      steps: stepsWithAction,
      showNavigation: true,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    fireEvent.click(screen.getByText("Next"))

    expect(mockOnAction).toHaveBeenCalledWith("step_2_action", { step: 1 })
  })

  it("should hide navigation when showNavigation is false", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-18",
      component: "InteractiveGuide",
      steps: createSteps(),
      showNavigation: false,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(screen.queryByText("Previous")).not.toBeInTheDocument()
    expect(screen.queryByText("Next")).not.toBeInTheDocument()
  })

  it("should hide progress when showProgress is false", () => {
    const component: A2UIInteractiveGuideComponentDef = {
      id: "guide-19",
      component: "InteractiveGuide",
      steps: createSteps(),
      showProgress: false,
    }

    render(<A2UIInteractiveGuide {...createProps(component)} />)
    expect(screen.queryByText(/Step 1 of 3/)).not.toBeInTheDocument()
  })
})
