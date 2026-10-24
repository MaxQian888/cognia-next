import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { A2UIBreadcrumb, type A2UIBreadcrumbComponent } from "./a2ui-breadcrumb"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "t",
    dataModel: {},
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    renderChild: jest.fn(),
  }),
  useA2UIData: () => ({
    resolveString: (v: unknown) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: unknown) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: unknown) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: unknown, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
}))

describe("A2UIBreadcrumb", () => {
  const cp = (c: A2UIBreadcrumbComponent): A2UIComponentProps<A2UIBreadcrumbComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders breadcrumb items", () => {
    render(
      <A2UIBreadcrumb
        {...cp({
          id: "bc1",
          component: "Breadcrumb",
          items: [
            { label: "Home", href: "/" },
            { label: "Page", current: true },
          ],
        })}
      />
    )
    expect(screen.getByText("Home")).toBeInTheDocument()
    expect(screen.getByText("Page")).toBeInTheDocument()
  })

  it("opens only web targets and keeps every other target an action", () => {
    const props = cp({
      id: "bc2",
      component: "Breadcrumb",
      items: [
        { label: "Docs", href: "https://example.com/docs" },
        { label: "Home", href: "/" },
        { label: "Evil", href: "javascript:alert(1)" },
        { label: "Here", current: true },
      ],
    })
    const { container } = render(<A2UIBreadcrumb {...props} />)

    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com/docs"
    )
    expect(container.querySelector('[href="/"]')).toBeNull()
    expect(container.querySelector('[href^="javascript"]')).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Home" }))
    expect(props.onAction).toHaveBeenCalledWith("navigate", { href: "/", label: "Home" })
    fireEvent.click(screen.getByRole("button", { name: "Evil" }))
    // The rejected scheme never reaches the action's handler or plugins.
    expect(props.onAction).toHaveBeenLastCalledWith("navigate", { label: "Evil" })
  })
})
