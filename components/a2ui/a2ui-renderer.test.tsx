/**
 * Tests for A2UI Renderer
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import {
  A2UIRenderer,
  withA2UIContext,
  registerBuiltInComponent,
  isComponentRegistered,
  getRegisteredComponentTypes,
} from "./a2ui-renderer"
import { A2UIChildRenderer } from "./a2ui-child-renderer"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

// Mock the context
const mockEmitAction = jest.fn()
const mockSetDataValue = jest.fn()
const mockRenderChild = jest.fn((id) => <div data-testid={`child-${id}`}>{id}</div>)

const mockContextValue = {
  surface: { id: "test-surface", type: "inline", ready: true },
  surfaceId: "test-surface",
  dataModel: { user: { name: "John" } },
  components: {},
  catalog: { id: "default", components: {} },
  emitAction: mockEmitAction,
  setDataValue: mockSetDataValue,
  resolveString: jest.fn((v) => (typeof v === "string" ? v : "resolved")),
  resolveNumber: jest.fn((v) => (typeof v === "number" ? v : 0)),
  resolveBoolean: jest.fn((v) => (typeof v === "boolean" ? v : false)),
  resolveArray: jest.fn((v) => (Array.isArray(v) ? v : [])),
  getBindingPath: jest.fn(() => null),
  getComponent: jest.fn(),
  renderChild: mockRenderChild,
}

jest.mock("@/hooks/a2ui/use-a2ui-context", () => ({
  useA2UIContext: jest.fn(() => mockContextValue),
  // The renderer now reads via the split hooks; both expose the same mock
  // fixture so existing assertions keep working.
  useA2UIActions: jest.fn(() => mockContextValue),
  useA2UIData: jest.fn(() => mockContextValue),
  useA2UIVisibility: jest.fn((visible) => {
    if (visible === undefined) return true
    if (typeof visible === "boolean") return visible
    return true
  }),
  useA2UIDisabled: jest.fn((disabled) => {
    if (disabled === undefined) return false
    if (typeof disabled === "boolean") return disabled
    return false
  }),
}))

jest.mock("@/lib/a2ui/catalog", () => ({
  getComponent: jest.fn(() => undefined),
}))

// Mock layout components
jest.mock("./layout/a2ui-row", () => ({
  A2UIRow: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-row" data-component-id={component.id}>
      Row
    </div>
  ),
}))

jest.mock("./layout/a2ui-column", () => ({
  A2UIColumn: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-column" data-component-id={component.id}>
      Column
    </div>
  ),
}))

jest.mock("./layout/a2ui-card", () => ({
  A2UICard: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-card" data-component-id={component.id}>
      Card
    </div>
  ),
}))

jest.mock("./layout/a2ui-divider", () => ({
  A2UIDivider: () => <hr data-testid="a2ui-divider" />,
}))

jest.mock("./layout/a2ui-spacer", () => ({
  A2UISpacer: () => <div data-testid="a2ui-spacer" />,
}))

jest.mock("./layout/a2ui-dialog", () => ({
  A2UIDialog: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-dialog" data-component-id={component.id}>
      Dialog
    </div>
  ),
}))

jest.mock("./layout/a2ui-fallback", () => ({
  A2UIFallback: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-fallback" data-component-id={component.id}>
      Unknown: {component.component}
    </div>
  ),
}))

// Mock display components
jest.mock("./display/a2ui-text", () => ({
  A2UIText: ({ component }: A2UIComponentProps) => (
    <span data-testid="a2ui-text" data-component-id={component.id}>
      Text
    </span>
  ),
}))

jest.mock("./display/a2ui-alert", () => ({
  A2UIAlert: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-alert" data-component-id={component.id}>
      Alert
    </div>
  ),
}))

jest.mock("./display/a2ui-progress", () => ({
  A2UIProgress: () => <div data-testid="a2ui-progress" />,
}))

jest.mock("./display/a2ui-badge", () => ({
  A2UIBadge: () => <span data-testid="a2ui-badge" />,
}))

jest.mock("./display/a2ui-image", () => ({
  A2UIImage: () => <div data-testid="a2ui-image" role="img" />,
}))

jest.mock("./display/a2ui-icon", () => ({
  A2UIIcon: () => <span data-testid="a2ui-icon" />,
}))

jest.mock("./display/a2ui-link", () => ({
  A2UILink: () => <a data-testid="a2ui-link" href="#" />,
}))

jest.mock("./display/a2ui-loading", () => ({
  A2UILoading: () => <div data-testid="a2ui-loading" />,
}))

jest.mock("./display/a2ui-error", () => ({
  A2UIError: () => <div data-testid="a2ui-error" />,
}))

jest.mock("./display/a2ui-empty", () => ({
  A2UIEmpty: () => <div data-testid="a2ui-empty" />,
}))

jest.mock("./display/a2ui-rich-output", () => ({
  A2UIRichOutput: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-rich-output" data-component-id={component.id}>
      Rich Output
    </div>
  ),
}))

jest.mock("./display/a2ui-comparison-cards", () => ({
  A2UIComparisonCards: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-comparison-cards" data-component-id={component.id}>
      Comparison Cards
    </div>
  ),
}))

jest.mock("./display/a2ui-widget-status", () => ({
  A2UIWidgetStatus: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-widget-status" data-component-id={component.id}>
      Widget Status
    </div>
  ),
}))

// Mock form components
jest.mock("./form/a2ui-button", () => ({
  A2UIButton: ({ component }: A2UIComponentProps) => (
    <button data-testid="a2ui-button" data-component-id={component.id}>
      Button
    </button>
  ),
}))

jest.mock("./form/a2ui-textfield", () => ({
  A2UITextField: () => <input data-testid="a2ui-textfield" />,
}))

jest.mock("./form/a2ui-textarea", () => ({
  A2UITextArea: () => <textarea data-testid="a2ui-textarea" />,
}))

jest.mock("./form/a2ui-select", () => ({
  A2UISelect: () => <select data-testid="a2ui-select" />,
}))

jest.mock("./form/a2ui-checkbox", () => ({
  A2UICheckbox: () => <input type="checkbox" data-testid="a2ui-checkbox" />,
}))

jest.mock("./form/a2ui-radio", () => ({
  A2UIRadio: () => <div data-testid="a2ui-radio-single" />,
  A2UIRadioGroup: () => <div data-testid="a2ui-radio" />,
}))

jest.mock("./form/a2ui-slider", () => ({
  A2UISlider: () => <input type="range" data-testid="a2ui-slider" />,
}))

jest.mock("./form/a2ui-datepicker", () => ({
  A2UIDatePicker: () => <input type="date" data-testid="a2ui-datepicker" />,
}))

jest.mock("./form/a2ui-timepicker", () => ({
  A2UITimePicker: () => <input type="time" data-testid="a2ui-timepicker" />,
}))

jest.mock("./form/a2ui-datetimepicker", () => ({
  A2UIDateTimePicker: () => <input type="datetime-local" data-testid="a2ui-datetimepicker" />,
}))

// Mock data components
jest.mock("./data/a2ui-chart", () => ({
  A2UIChart: () => <div data-testid="a2ui-chart" />,
}))

jest.mock("./data/a2ui-table", () => ({
  A2UITable: () => <table data-testid="a2ui-table" />,
}))

jest.mock("./data/a2ui-list", () => ({
  A2UIList: () => <ul data-testid="a2ui-list" />,
}))

jest.mock("./layout/a2ui-stepper-shell", () => ({
  A2UIStepperShell: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-stepper-shell" data-component-id={component.id}>
      Stepper Shell
    </div>
  ),
}))

jest.mock("./layout/a2ui-mockup-frame", () => ({
  A2UIMockupFrame: ({ component }: A2UIComponentProps) => (
    <div data-testid="a2ui-mockup-frame" data-component-id={component.id}>
      Mockup Frame
    </div>
  ),
}))

describe("A2UIRenderer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render built-in Row component", () => {
    const component = { id: "row1", component: "Row", children: [] }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-row")).toBeInTheDocument()
  })

  it("should render built-in Column component", () => {
    const component = { id: "col1", component: "Column", children: [] }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-column")).toBeInTheDocument()
  })

  it("should render built-in Text component", () => {
    const component = { id: "text1", component: "Text", props: { content: "Hello" } }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-text")).toBeInTheDocument()
  })

  it("should render built-in Button component", () => {
    const component = { id: "btn1", component: "Button", props: { label: "Click" } }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-button")).toBeInTheDocument()
  })

  it("should render built-in RichOutput component", () => {
    const component = { id: "rich1", component: "RichOutput", profileId: "quick-factual-answer" }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-rich-output")).toBeInTheDocument()
  })

  it("should render reusable widget family components", () => {
    const cases = [
      { id: "comparison-1", component: "ComparisonCards", testId: "a2ui-comparison-cards" },
      { id: "stepper-1", component: "StepperShell", testId: "a2ui-stepper-shell" },
      { id: "mockup-1", component: "MockupFrame", testId: "a2ui-mockup-frame" },
      { id: "status-1", component: "WidgetStatus", testId: "a2ui-widget-status" },
    ]

    cases.forEach(({ id, component, testId }) => {
      const { unmount } = render(<A2UIRenderer component={{ id, component }} />)
      expect(screen.getByTestId(testId)).toBeInTheDocument()
      unmount()
    })
  })

  it("should render fallback for unknown component type", () => {
    const component = { id: "unknown1", component: "UnknownComponent", props: {} }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-fallback")).toBeInTheDocument()
    expect(screen.getByTestId("a2ui-fallback")).toHaveTextContent("UnknownComponent")
  })

  it("should not render when visibility is false", () => {
    const { useA2UIVisibility } = jest.requireMock("@/hooks/a2ui/use-a2ui-context")
    useA2UIVisibility.mockReturnValueOnce(false)

    const component = { id: "hidden1", component: "Text", visible: false }
    const { container } = render(<A2UIRenderer component={component} />)
    expect(container.firstChild).toBeNull()
  })

  it("should pass className to component", () => {
    const component = { id: "text1", component: "Row", className: "custom-class" }
    render(<A2UIRenderer component={component} className="additional-class" />)
    // Component receives the className prop
    expect(screen.getByTestId("a2ui-row")).toBeInTheDocument()
  })

  it("should render Card component", () => {
    const component = { id: "card1", component: "Card", children: [] }
    render(<A2UIRenderer component={component} />)
    expect(screen.getByTestId("a2ui-card")).toBeInTheDocument()
  })

  it("should render form components", () => {
    const components = [
      { id: "tf1", component: "TextField" },
      { id: "ta1", component: "TextArea" },
      { id: "sel1", component: "Select" },
      { id: "cb1", component: "Checkbox" },
    ]

    components.forEach((comp) => {
      const { unmount } = render(<A2UIRenderer component={comp} />)
      expect(screen.getByTestId(`a2ui-${comp.component.toLowerCase()}`)).toBeInTheDocument()
      unmount()
    })
  })

  it("should render single Radio component", () => {
    render(<A2UIRenderer component={{ id: "radio1", component: "Radio" }} />)
    expect(screen.getByTestId("a2ui-radio-single")).toBeInTheDocument()
  })

  it("should render data components", () => {
    // Chart is lazy-loaded (React.lazy), tested separately
    const components = [
      { id: "table1", component: "Table" },
      { id: "list1", component: "List" },
    ]

    components.forEach((comp) => {
      const { unmount } = render(<A2UIRenderer component={comp} />)
      expect(screen.getByTestId(`a2ui-${comp.component.toLowerCase()}`)).toBeInTheDocument()
      unmount()
    })
  })

  it("should render lazy Chart component with Suspense fallback", async () => {
    const component = { id: "chart1", component: "Chart" }
    const { container } = render(<A2UIRenderer component={component} />)
    expect(
      container.querySelector(".animate-pulse") || screen.queryByTestId("a2ui-chart")
    ).toBeTruthy()
    expect(await screen.findByTestId("a2ui-chart")).toBeInTheDocument()
  })
})

describe("A2UIChildRenderer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should render all child components", () => {
    render(<A2UIChildRenderer childIds={["child1", "child2", "child3"]} />)

    expect(screen.getByTestId("child-child1")).toBeInTheDocument()
    expect(screen.getByTestId("child-child2")).toBeInTheDocument()
    expect(screen.getByTestId("child-child3")).toBeInTheDocument()
  })

  it("should render empty when no children", () => {
    const { container } = render(<A2UIChildRenderer childIds={[]} />)
    expect(container.textContent).toBe("")
  })
})

describe("withA2UIContext", () => {
  it("should wrap component with context access", () => {
    const TestComponent = ({ component, onAction }: A2UIComponentProps) => (
      <button data-testid="wrapped" onClick={() => onAction?.("click", { test: true })}>
        {component.id}
      </button>
    )

    const WrappedComponent = withA2UIContext(TestComponent)
    const component = { id: "wrapped1", component: "Test" }

    render(<WrappedComponent component={component} />)

    expect(screen.getByTestId("wrapped")).toHaveTextContent("wrapped1")

    screen.getByTestId("wrapped").click()
    expect(mockEmitAction).toHaveBeenCalledWith("click", "wrapped1", { test: true })
  })
})

describe("registerBuiltInComponent", () => {
  it("should register a new component", () => {
    const CustomComponent = ({ component }: A2UIComponentProps) => (
      <div data-testid="custom">{component.id}</div>
    )

    registerBuiltInComponent("CustomTest", CustomComponent)

    expect(isComponentRegistered("CustomTest")).toBe(true)
  })
})

describe("isComponentRegistered", () => {
  it("should return true for built-in components", () => {
    expect(isComponentRegistered("Row")).toBe(true)
    expect(isComponentRegistered("Column")).toBe(true)
    expect(isComponentRegistered("Text")).toBe(true)
    expect(isComponentRegistered("Button")).toBe(true)
  })

  it("should return false for unregistered components", () => {
    expect(isComponentRegistered("NonExistent")).toBe(false)
  })
})

describe("getRegisteredComponentTypes", () => {
  it("should return list of registered component types", () => {
    const types = getRegisteredComponentTypes()

    expect(types).toContain("Row")
    expect(types).toContain("Column")
    expect(types).toContain("Text")
    expect(types).toContain("Button")
    expect(types).toContain("Card")
    expect(types).toContain("Chart")
    expect(types).toContain("Table")
    expect(types).toContain("RichOutput")
    expect(types).toContain("ComparisonCards")
    expect(types).toContain("StepperShell")
    expect(types).toContain("MockupFrame")
    expect(types).toContain("WidgetStatus")
    // Academic components are bridged in via withA2UIContext adapters.
    expect(types).toContain("AcademicAnalysis")
    expect(types).toContain("AcademicSearchResults")
  })

  it("should return an array", () => {
    const types = getRegisteredComponentTypes()
    expect(Array.isArray(types)).toBe(true)
  })
})
