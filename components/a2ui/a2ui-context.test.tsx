/**
 * Tests for A2UI Context
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import {
  A2UIProvider,
  useA2UIContext,
  useA2UIComponent,
  useA2UIBinding,
  useA2UIVisibility,
  useA2UIDisabled,
} from "./a2ui-context"

// Mock the store
const mockEmitAction = jest.fn()
const mockSetDataValue = jest.fn()

const mockSurface = {
  id: "test-surface",
  type: "inline" as const,
  ready: true,
  rootId: "root",
  components: {
    root: { id: "root", component: "Column", children: ["child1"] },
    child1: { id: "child1", component: "Text", props: { content: "Hello" } },
  },
  dataModel: {
    user: {
      name: "John",
      age: 30,
      active: true,
    },
    items: ["a", "b", "c"],
  },
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: jest.fn((selector) => {
    const state = {
      surfaces: { "test-surface": mockSurface },
      emitAction: mockEmitAction,
      setDataValue: mockSetDataValue,
    }
    return selector(state)
  }),
}))

jest.mock("@/lib/a2ui/data-model", () => ({
  resolveStringOrPath: jest.fn((value, dataModel, defaultValue) => {
    if (typeof value === "string") return value
    if (value?.path) {
      const segments = value.path.split("/").filter(Boolean)
      let current: unknown = dataModel
      for (const seg of segments) {
        current = (current as Record<string, unknown>)?.[seg]
      }
      return (current as string) ?? defaultValue
    }
    return defaultValue
  }),
  resolveNumberOrPath: jest.fn((value, dataModel, defaultValue) => {
    if (typeof value === "number") return value
    if (value?.path) {
      const segments = value.path.split("/").filter(Boolean)
      let current: unknown = dataModel
      for (const seg of segments) {
        current = (current as Record<string, unknown>)?.[seg]
      }
      return (current as number) ?? defaultValue
    }
    return defaultValue
  }),
  resolveBooleanOrPath: jest.fn((value, dataModel, defaultValue) => {
    if (typeof value === "boolean") return value
    if (value?.path) {
      const segments = value.path.split("/").filter(Boolean)
      let current: unknown = dataModel
      for (const seg of segments) {
        current = (current as Record<string, unknown>)?.[seg]
      }
      return (current as boolean) ?? defaultValue
    }
    return defaultValue
  }),
  resolveArrayOrPath: jest.fn((value, dataModel, defaultValue) => {
    if (Array.isArray(value)) return value
    if (value?.path) {
      const segments = value.path.split("/").filter(Boolean)
      let current: unknown = dataModel
      for (const seg of segments) {
        current = (current as Record<string, unknown>)?.[seg]
      }
      return (current as unknown[]) ?? defaultValue
    }
    return defaultValue
  }),
  getValueByPath: jest.fn((dataModel, path) => {
    if (!path || path === "/") {
      return dataModel
    }

    const segments = String(path)
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    let current: unknown = dataModel

    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined
      }
      const container = current as Record<string, unknown>
      if (!(segment in container)) {
        return undefined
      }
      current = container[segment]
    }

    return current
  }),
  getBindingPath: jest.fn((value) => {
    if (value && typeof value === "object" && "path" in value) {
      return (value as { path: string }).path
    }
    return null
  }),
}))

jest.mock("@/lib/a2ui/catalog", () => ({
  getCatalog: jest.fn(() => ({ id: "default", components: {} })),
  DEFAULT_CATALOG_ID: "default",
}))

describe("A2UIProvider", () => {
  const mockRenderComponent = jest.fn((component) => (
    <div data-testid={`component-${component.id}`}>{component.id}</div>
  ))

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("should provide context to children", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return <div data-testid="surfaceId">{context.surfaceId}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("surfaceId")).toHaveTextContent("test-surface")
  })

  it("should provide surface state", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return (
        <div>
          <div data-testid="surface-type">{context.surface?.type}</div>
          <div data-testid="root-id">{context.surface?.rootId}</div>
        </div>
      )
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("surface-type")).toHaveTextContent("inline")
    expect(screen.getByTestId("root-id")).toHaveTextContent("root")
  })

  it("should provide dataModel", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return <div data-testid="data">{JSON.stringify(context.dataModel)}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    const data = JSON.parse(screen.getByTestId("data").textContent || "{}")
    expect(data.user.name).toBe("John")
  })

  it("should call emitAction with correct parameters", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return (
        <button
          data-testid="action-btn"
          onClick={() => context.emitAction("click", "btn1", { value: 42 })}
        >
          Click
        </button>
      )
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    screen.getByTestId("action-btn").click()

    expect(mockEmitAction).toHaveBeenCalledWith("test-surface", "click", "btn1", { value: 42 })
  })

  it("should call setDataValue with correct parameters", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return (
        <button data-testid="set-btn" onClick={() => context.setDataValue("/user/name", "Jane")}>
          Set
        </button>
      )
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    screen.getByTestId("set-btn").click()

    expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/user/name", "Jane")
  })

  it("should not emit actions when readOnly", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return (
        <button
          data-testid="action-btn"
          onClick={() => context.emitAction("click", "btn1", { value: 42 })}
        >
          Click
        </button>
      )
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent} readOnly>
        <TestChild />
      </A2UIProvider>
    )

    screen.getByTestId("action-btn").click()

    expect(mockEmitAction).not.toHaveBeenCalled()
  })

  it("should not mutate data when readOnly", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return (
        <button data-testid="set-btn" onClick={() => context.setDataValue("/user/name", "Jane")}>
          Set
        </button>
      )
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent} readOnly>
        <TestChild />
      </A2UIProvider>
    )

    screen.getByTestId("set-btn").click()

    expect(mockSetDataValue).not.toHaveBeenCalled()
  })

  it("should resolve string values", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      const resolved = context.resolveString({ path: "/user/name" }, "default")
      return <div data-testid="resolved">{resolved}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("resolved")).toHaveTextContent("John")
  })

  it("should get component by id", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      const component = context.getComponent("child1")
      return <div data-testid="component-type">{component?.component}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("component-type")).toHaveTextContent("Text")
  })

  it("should render child component", () => {
    const TestChild = () => {
      const context = useA2UIContext()
      return <div data-testid="child-container">{context.renderChild("child1")}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("component-child1")).toBeInTheDocument()
  })
})

describe("useA2UIContext", () => {
  it("should throw error when used outside provider", () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})

    const TestComponent = () => {
      useA2UIContext()
      return null
    }

    expect(() => render(<TestComponent />)).toThrow(
      "useA2UIContext must be used within an A2UIProvider"
    )

    consoleError.mockRestore()
  })
})

describe("useA2UIComponent", () => {
  const mockRenderComponent = jest.fn((component) => (
    <div data-testid={`component-${component.id}`}>{component.id}</div>
  ))

  it("should return component by id", () => {
    const TestChild = () => {
      const component = useA2UIComponent("child1")
      return <div data-testid="component">{component?.component}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("component")).toHaveTextContent("Text")
  })

  it("should return undefined for non-existent component", () => {
    const TestChild = () => {
      const component = useA2UIComponent("non-existent")
      return <div data-testid="component">{component ? "found" : "not-found"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("component")).toHaveTextContent("not-found")
  })
})

describe("useA2UIBinding", () => {
  const mockRenderComponent = jest.fn(() => null)

  it("should return value and setter for path", () => {
    const TestChild = () => {
      const [value, setValue] = useA2UIBinding("/user/name", "default")
      return (
        <div>
          <div data-testid="value">{value}</div>
          <button data-testid="set" onClick={() => setValue("Updated")}>
            Set
          </button>
        </div>
      )
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("value")).toHaveTextContent("John")

    screen.getByTestId("set").click()

    expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/user/name", "Updated")
  })

  it("should return default value for non-existent path", () => {
    const TestChild = () => {
      const [value] = useA2UIBinding("/non/existent", "fallback")
      return <div data-testid="value">{value}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("value")).toHaveTextContent("fallback")
  })
})

describe("useA2UIVisibility", () => {
  const mockRenderComponent = jest.fn(() => null)

  it("should return true when visible is undefined", () => {
    const TestChild = () => {
      const isVisible = useA2UIVisibility(undefined)
      return <div data-testid="visible">{isVisible ? "yes" : "no"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("visible")).toHaveTextContent("yes")
  })

  it("should return boolean value directly", () => {
    const TestChild = () => {
      const isVisible = useA2UIVisibility(false)
      return <div data-testid="visible">{isVisible ? "yes" : "no"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("visible")).toHaveTextContent("no")
  })

  it("should resolve path binding for visibility", () => {
    const TestChild = () => {
      const isVisible = useA2UIVisibility({ path: "/user/active" })
      return <div data-testid="visible">{isVisible ? "yes" : "no"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("visible")).toHaveTextContent("yes")
  })
})

describe("useA2UIDisabled", () => {
  const mockRenderComponent = jest.fn(() => null)

  it("should return false when disabled is undefined", () => {
    const TestChild = () => {
      const isDisabled = useA2UIDisabled(undefined)
      return <div data-testid="disabled">{isDisabled ? "yes" : "no"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("disabled")).toHaveTextContent("no")
  })

  it("should return boolean value directly", () => {
    const TestChild = () => {
      const isDisabled = useA2UIDisabled(true)
      return <div data-testid="disabled">{isDisabled ? "yes" : "no"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    expect(screen.getByTestId("disabled")).toHaveTextContent("yes")
  })

  it("should resolve path binding for disabled state", () => {
    const TestChild = () => {
      const isDisabled = useA2UIDisabled({ path: "/user/active" })
      return <div data-testid="disabled">{isDisabled ? "yes" : "no"}</div>
    }

    render(
      <A2UIProvider surfaceId="test-surface" renderComponent={mockRenderComponent}>
        <TestChild />
      </A2UIProvider>
    )

    // active is true, so disabled should be true
    expect(screen.getByTestId("disabled")).toHaveTextContent("yes")
  })
})
