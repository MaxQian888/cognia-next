/**
 * A2UI Tabs Component Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { A2UITabs } from "./a2ui-tabs"
import type { A2UITabsComponent, A2UIComponentProps } from "@/types/a2ui/schema"

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

// Mock A2UIChildRenderer
jest.mock("../a2ui-child-renderer", () => ({
  A2UIChildRenderer: ({ childIds }: { childIds: string[] }) => (
    <div data-testid="child-renderer">{childIds.join(",")}</div>
  ),
}))

describe("A2UITabs", () => {
  const mockOnAction = jest.fn()
  const mockOnDataChange = jest.fn()
  const mockRenderChild = jest.fn(() => null)

  const createProps = (component: A2UITabsComponent): A2UIComponentProps<A2UITabsComponent> => ({
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

  it("follows external activeTab changes and writes tab selections", async () => {
    const component: A2UITabsComponent = {
      id: "bound",
      component: "Tabs",
      activeTab: { path: "/tab" },
      tabs: [
        { id: "one", label: "One", children: [] },
        { id: "two", label: "Two", children: [] },
      ],
    }
    mockDataCtx.dataModel = { tab: "one" }
    const { rerender } = render(<A2UITabs {...createProps(component)} />)
    mockDataCtx.dataModel = { tab: "two" }
    rerender(<A2UITabs {...createProps({ ...component })} />)
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true")
    await userEvent.click(screen.getByRole("tab", { name: "One" }))
    expect(mockOnDataChange).toHaveBeenCalledWith("/tab", "one")
    mockDataCtx.dataModel = {}
  })

  it("renders a configured tab icon", () => {
    render(
      <A2UITabs
        {...createProps({
          id: "icons",
          component: "Tabs",
          tabs: [{ id: "one", label: "One", icon: "Star", children: [] }],
        })}
      />
    )
    expect(screen.getByRole("tab", { name: "One" }).querySelector("svg")).toBeInTheDocument()
  })

  it("should render tabs with labels", () => {
    const component: A2UITabsComponent = {
      id: "tabs-1",
      component: "Tabs",
      tabs: [
        { id: "tab1", label: "First Tab", children: ["child-1"] },
        { id: "tab2", label: "Second Tab", children: ["child-2"] },
      ],
    }

    render(<A2UITabs {...createProps(component)} />)
    expect(screen.getByRole("tab", { name: "First Tab" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Second Tab" })).toBeInTheDocument()
  })

  it("should activate first tab by default", () => {
    const component: A2UITabsComponent = {
      id: "tabs-2",
      component: "Tabs",
      tabs: [
        { id: "tab1", label: "Tab A", children: ["child-a"] },
        { id: "tab2", label: "Tab B", children: ["child-b"] },
      ],
    }

    render(<A2UITabs {...createProps(component)} />)
    expect(screen.getByRole("tab", { name: "Tab A" })).toHaveAttribute("aria-selected", "true")
  })

  it("should use defaultTab when specified", () => {
    const component: A2UITabsComponent = {
      id: "tabs-3",
      component: "Tabs",
      defaultTab: "tab2",
      tabs: [
        { id: "tab1", label: "Tab A", children: ["child-a"] },
        { id: "tab2", label: "Tab B", children: ["child-b"] },
      ],
    }

    render(<A2UITabs {...createProps(component)} />)
    expect(screen.getByRole("tab", { name: "Tab B" })).toHaveAttribute("aria-selected", "true")
  })

  it("should fire tabChangeAction when switching tabs", async () => {
    const component: A2UITabsComponent = {
      id: "tabs-4",
      component: "Tabs",
      tabChangeAction: "tab_changed",
      tabs: [
        { id: "tab1", label: "Tab A", children: ["child-a"] },
        { id: "tab2", label: "Tab B", children: ["child-b"] },
      ],
    }

    render(<A2UITabs {...createProps(component)} />)
    await userEvent.click(screen.getByRole("tab", { name: "Tab B" }))

    expect(mockOnAction).toHaveBeenCalledWith("tab_changed", { tab: "tab2" })
  })

  it("should render disabled tabs", () => {
    const component: A2UITabsComponent = {
      id: "tabs-5",
      component: "Tabs",
      tabs: [
        { id: "tab1", label: "Enabled", children: ["child-1"] },
        { id: "tab2", label: "Disabled", children: ["child-2"], disabled: true },
      ],
    }

    render(<A2UITabs {...createProps(component)} />)
    expect(screen.getByRole("tab", { name: "Disabled" })).toBeDisabled()
  })
})
