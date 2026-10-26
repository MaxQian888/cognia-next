import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UICollapsible, type A2UICollapsibleComponent } from "./a2ui-collapsible"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "t",
    dataModel: {},
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  }),
  useA2UIData: () => ({
    resolveString: (v: unknown) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: unknown) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: unknown) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: unknown, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
}))

describe("A2UICollapsible", () => {
  const cp = (c: A2UICollapsibleComponent): A2UIComponentProps<A2UICollapsibleComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("follows external open updates and writes user toggles to the binding", () => {
    const props = cp({
      id: "bound",
      component: "Collapsible",
      title: "Bound details",
      children: ["body"],
      open: false,
    })
    const { rerender } = render(<A2UICollapsible {...props} />)
    expect(screen.queryByText("body")).not.toBeInTheDocument()
    rerender(<A2UICollapsible {...props} component={{ ...props.component, open: true }} />)
    expect(screen.getByText("body")).toBeInTheDocument()
    rerender(
      <A2UICollapsible {...props} component={{ ...props.component, open: { path: "/expanded" } }} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Bound details" }))
    expect(props.onDataChange).toHaveBeenCalledWith("/expanded", true)
  })

  it("renders title", () => {
    render(
      <A2UICollapsible
        {...cp({ id: "cl1", component: "Collapsible", title: "Details", children: [] })}
      />
    )
    expect(screen.getByText("Details")).toBeInTheDocument()
  })

  it("renders children", () => {
    render(
      <A2UICollapsible
        {...cp({
          id: "cl2",
          component: "Collapsible",
          title: "More",
          children: ["c1"],
          open: true,
        })}
      />
    )
    expect(screen.getByTestId("c1")).toBeInTheDocument()
  })
})
