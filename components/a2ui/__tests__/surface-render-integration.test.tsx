/**
 * A2UI Surface Render Integration Tests
 *
 * Verifies that A2UI surfaces seeded from templates render the expected
 * elements through the store -> A2UISurface -> A2UIProvider -> renderer
 * pipeline.
 *
 * The A2UIRenderer is replaced with a lightweight stub that resolves the
 * component tree using the real A2UIProvider context (data binding, actions).
 * This validates that:
 *   - The store feeds the correct surface data to A2UISurface
 *   - A2UIProvider resolves data-model bindings (e.g., { path: '/display' })
 *   - The renderer receives the right component definitions and renders them
 *   - User interactions flow back through the provider to the store
 *
 * Templates tested: todo-list, calculator, survey-form.
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import "@testing-library/jest-dom"
import type {
  A2UIComponent,
  A2UISurfaceState,
  A2UITextComponent,
  A2UIButtonComponent,
  A2UITextFieldComponent,
  A2UIColumnComponent,
  A2UIRowComponent,
  A2UICardComponent,
  A2UIListComponent,
  A2UIBadgeComponent,
  A2UISliderComponent,
  A2UITextAreaComponent,
} from "@/types/a2ui/schema"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

// ---------------------------------------------------------------------------
// Mocks — external dependencies
// ---------------------------------------------------------------------------

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
    ai: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  },
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) =>
    args
      .flat(Infinity)
      .filter((a) => typeof a === "string" && a.length > 0)
      .join(" "),
}))

jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: {
    onAction: jest.fn(() => jest.fn()),
    onDataChange: jest.fn(() => jest.fn()),
    emitAction: jest.fn(),
    emitDataChange: jest.fn(),
  },
  createUserAction: jest.fn(
    (surfaceId: string, action: string, componentId: string, data?: Record<string, unknown>) => ({
      type: "userAction",
      surfaceId,
      action,
      componentId,
      data,
      timestamp: Date.now(),
    })
  ),
  createDataModelChange: jest.fn((surfaceId: string, path: string, value: unknown) => ({
    type: "dataModelChange",
    surfaceId,
    path,
    value,
    timestamp: Date.now(),
  })),
}))

jest.mock("@/lib/a2ui/catalog", () => ({
  getComponent: jest.fn(() => undefined),
  getCatalog: jest.fn(() => ({ id: "default", name: "Default", version: "1.0", components: {} })),
  DEFAULT_CATALOG_ID: "cognia-standard-v1",
}))

jest.mock("@/lib/a2ui/constants", () => ({
  surfaceStyles: { inline: "w-full", dialog: "fixed inset-0 z-50", panel: "", fullscreen: "" },
  contentStyles: { inline: "", dialog: "", panel: "", fullscreen: "" },
  CATEGORY_KEYS: ["productivity", "data", "form", "utility", "social"],
  CATEGORY_I18N_MAP: {},
}))

jest.mock("../a2ui-widget-shell", () => ({
  A2UIWidgetShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="a2ui-widget-shell">{children}</div>
  ),
}))

// ---------------------------------------------------------------------------
// Store mock
// ---------------------------------------------------------------------------

let surfaceData: Record<string, A2UISurfaceState> = {}
const loadingSurfaces: Record<string, true> = {}
const streamingSurfaces: Record<string, true> = {}
const errorData: Record<string, string> = {}

const mockEmitAction = jest.fn()
const mockSetDataValue = jest.fn()

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: jest.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      surfaces: surfaceData,
      loadingSurfaces,
      streamingSurfaces,
      errors: errorData,
      emitAction: mockEmitAction,
      setDataValue: mockSetDataValue,
      deleteSurface: jest.fn(),
    }
    return selector(state)
  }),
}))

// ---------------------------------------------------------------------------
// Renderer mock — a lightweight stub that uses the real A2UIProvider context
// to resolve data bindings and render a simplified DOM tree.
// ---------------------------------------------------------------------------

/**
 * StubRenderer reads the component definition + context to produce real DOM
 * elements (headings, buttons, inputs, etc.) so that we can query them in
 * tests.
 */
function StubRenderer({ component }: { component: A2UIComponent }) {
  // Access the real A2UIProvider context
  const { useA2UIData, useA2UIActions } = jest.requireActual(
    "@/hooks/a2ui/use-a2ui-context"
  ) as typeof import("@/hooks/a2ui/use-a2ui-context")

  const { resolveString, resolveNumber, resolveBoolean, resolveArray } = useA2UIData()
  const { emitAction, setDataValue, renderChild } = useA2UIActions()

  const type = component.component

  // --- Layout: Column / Row ---
  if (type === "Column" || type === "Row") {
    const c = component as A2UIColumnComponent | A2UIRowComponent
    const children = c.children || []
    return (
      <div data-testid={`stub-${type.toLowerCase()}-${c.id}`}>
        {children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </div>
    )
  }

  // --- Card ---
  if (type === "Card") {
    const c = component as A2UICardComponent
    const title = c.title ? resolveString(c.title, "") : ""
    const description = c.description ? resolveString(c.description, "") : ""
    return (
      <div data-testid={`stub-card-${c.id}`}>
        {title && <h3>{title}</h3>}
        {description && <p>{description}</p>}
        {c.children?.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </div>
    )
  }

  // --- Text ---
  if (type === "Text") {
    const c = component as A2UITextComponent
    const text = resolveString(c.text, "")
    const variant = c.variant || "body"

    if (variant === "heading1") return <h1>{text}</h1>
    if (variant === "heading2") return <h2>{text}</h2>
    if (variant === "heading3") return <h3>{text}</h3>
    if (variant === "heading4") return <h4>{text}</h4>
    if (variant === "label") return <label>{text}</label>
    if (variant === "caption") return <span className="caption">{text}</span>
    return <p>{text}</p>
  }

  // --- Button ---
  if (type === "Button") {
    const c = component as A2UIButtonComponent
    const text = resolveString(c.text, "")
    const isDisabled = c.disabled ? resolveBoolean(c.disabled, false) : false

    const handleClick = () => {
      if (!isDisabled && c.action) {
        emitAction(c.action, c.id, { text })
      }
    }

    return (
      <button onClick={handleClick} disabled={isDisabled}>
        {text}
      </button>
    )
  }

  // --- TextField ---
  if (type === "TextField") {
    const c = component as A2UITextFieldComponent
    const value = resolveString(c.value, "")
    const bindingPath =
      typeof c.value === "object" && c.value !== null && "path" in c.value
        ? (c.value as { path: string }).path
        : null

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (bindingPath) {
        setDataValue(bindingPath, e.target.value)
      }
    }

    return (
      <div>
        {c.label && <label htmlFor={c.id}>{c.label}</label>}
        <input
          id={c.id}
          type={c.type || "text"}
          value={value}
          onChange={handleChange}
          placeholder={c.placeholder}
          disabled={c.disabled ? resolveBoolean(c.disabled, false) : false}
        />
      </div>
    )
  }

  // --- TextArea ---
  if (type === "TextArea") {
    const c = component as A2UITextAreaComponent
    const value = resolveString(c.value, "")
    return (
      <div>
        {c.label && <label htmlFor={c.id}>{c.label}</label>}
        <textarea id={c.id} value={value} placeholder={c.placeholder} readOnly />
      </div>
    )
  }

  // --- List ---
  if (type === "List") {
    const c = component as A2UIListComponent
    const items = c.items
      ? Array.isArray(c.items)
        ? c.items
        : resolveArray(c.items as { path: string }, [])
      : []

    if (items.length === 0 && c.emptyText) {
      return <div>{c.emptyText}</div>
    }

    return (
      <ul>
        {(items as unknown[]).map((item, i) => (
          <li key={i}>{typeof item === "string" ? item : JSON.stringify(item)}</li>
        ))}
      </ul>
    )
  }

  // --- Badge ---
  if (type === "Badge") {
    const c = component as A2UIBadgeComponent
    const text = resolveString(c.text, "")
    return <span data-testid={`badge-${c.id}`}>{text}</span>
  }

  // --- Slider ---
  if (type === "Slider") {
    const c = component as A2UISliderComponent
    const value = resolveNumber(c.value, 0)
    return (
      <div data-testid={`slider-${c.id}`}>
        <input type="range" value={value} min={c.min} max={c.max} readOnly />
      </div>
    )
  }

  // --- Fallback ---
  return <div data-testid={`stub-fallback-${component.id}`}>[{type}]</div>
}

jest.mock("../a2ui-renderer", () => ({
  A2UIRenderer: ({ component }: { component: A2UIComponent }) => (
    <StubRenderer component={component} />
  ),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedSurface(surfaceId: string, template: A2UIAppTemplate): void {
  const componentMap: Record<string, A2UIComponent> = {}
  for (const comp of template.components) {
    componentMap[comp.id] = comp
  }

  surfaceData[surfaceId] = {
    id: surfaceId,
    type: "inline",
    catalogId: "cognia-standard-v1",
    title: template.name,
    components: componentMap,
    dataModel: JSON.parse(JSON.stringify(template.dataModel)),
    rootId: "root",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ready: true,
  }
}

// ---------------------------------------------------------------------------
// Imports under test (jest.mock hoists above ES imports, so these get mocks)
// ---------------------------------------------------------------------------

import { A2UISurface } from "../a2ui-surface"
import { todoListTemplate, calculatorTemplate, surveyFormTemplate } from "@/lib/a2ui/templates"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A2UI Surface Render Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    surfaceData = {}
  })

  // =========================================================================
  // Todo List Template
  // =========================================================================
  describe("todo-list template", () => {
    const SURFACE_ID = "test-todo"

    beforeEach(() => {
      seedSurface(SURFACE_ID, todoListTemplate)
    })

    it("renders the heading text", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByText(/My Tasks/)).toBeInTheDocument()
    })

    it("renders the Add button", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByRole("button", { name: /Add/i })).toBeInTheDocument()
    })

    it("renders the empty state text when tasks list is empty", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByText(/No tasks yet/i)).toBeInTheDocument()
    })

    it("renders stat badges", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByText("0 completed")).toBeInTheDocument()
      expect(screen.getByText("0 pending")).toBeInTheDocument()
    })
  })

  // =========================================================================
  // Calculator Template
  // =========================================================================
  describe("calculator template", () => {
    const SURFACE_ID = "test-calc"

    beforeEach(() => {
      seedSurface(SURFACE_ID, calculatorTemplate)
    })

    it('renders the display showing "0"', () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      // The display text is inside a heading (h2 via variant: heading2).
      // There is also a "0" button, so we disambiguate by element type.
      const headings = screen.getAllByText("0")
      const displayHeading = headings.find((el) => el.tagName === "H2")
      expect(displayHeading).toBeDefined()
      expect(displayHeading).toBeInTheDocument()
    })

    it("renders number buttons 0 through 9", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      for (let i = 0; i <= 9; i++) {
        expect(screen.getByRole("button", { name: String(i) })).toBeInTheDocument()
      }
    })

    it("renders operator buttons", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByRole("button", { name: "+" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "-" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "\u00D7" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "\u00F7" })).toBeInTheDocument()
    })

    it("renders the equals button", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByRole("button", { name: "=" })).toBeInTheDocument()
    })

    it("renders the clear (C) button", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByRole("button", { name: "C" })).toBeInTheDocument()
    })

    it("clicking a number button triggers emitAction through the store", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      const btn5 = screen.getByRole("button", { name: "5" })
      fireEvent.click(btn5)

      expect(mockEmitAction).toHaveBeenCalledWith(
        SURFACE_ID,
        "input_5",
        "btn-5",
        expect.any(Object)
      )
    })
  })

  // =========================================================================
  // Survey Form Template
  // =========================================================================
  describe("survey-form template", () => {
    const SURFACE_ID = "test-survey"

    beforeEach(() => {
      seedSurface(SURFACE_ID, surveyFormTemplate)
    })

    it('renders the heading "Quick Survey"', () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByText(/Quick Survey/)).toBeInTheDocument()
    })

    it("renders the name input field with placeholder", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByPlaceholderText("Enter your name")).toBeInTheDocument()
    })

    it("renders the email input field", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByPlaceholderText("your@email.com")).toBeInTheDocument()
    })

    it("renders the Submit button", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByRole("button", { name: /Submit/i })).toBeInTheDocument()
    })

    it("renders the Clear button", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      expect(screen.getByRole("button", { name: /Clear/i })).toBeInTheDocument()
    })

    it("typing in the name field triggers a data model change", () => {
      render(<A2UISurface surfaceId={SURFACE_ID} />)
      const nameInput = screen.getByPlaceholderText("Enter your name")

      fireEvent.change(nameInput, { target: { value: "Alice" } })

      expect(mockSetDataValue).toHaveBeenCalledWith(SURFACE_ID, "/form/name", "Alice")
    })
  })
})
