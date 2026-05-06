import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIButtonGroup, type A2UIButtonGroupComponent } from "./a2ui-button-group"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "test",
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

describe("A2UIButtonGroup", () => {
  const cp = (c: A2UIButtonGroupComponent): A2UIComponentProps<A2UIButtonGroupComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders children", () => {
    render(
      <A2UIButtonGroup
        {...cp({ id: "bg1", component: "ButtonGroup", children: ["btn1", "btn2"] })}
      />
    )
    expect(screen.getByTestId("btn1")).toBeInTheDocument()
    expect(screen.getByTestId("btn2")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    const { container } = render(
      <A2UIButtonGroup
        {...cp({ id: "bg2", component: "ButtonGroup", children: [], className: "gap-2" })}
      />
    )
    expect(container.querySelector(".gap-2")).toBeInTheDocument()
  })
})
