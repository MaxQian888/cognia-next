import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UITextField } from "./a2ui-textfield"
import { A2UIInputGroup, type A2UIInputGroupComponent } from "./a2ui-input-group"
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

describe("A2UIInputGroup", () => {
  const cp = (c: A2UIInputGroupComponent): A2UIComponentProps<A2UIInputGroupComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("composes a direct input control with prefix and suffix addons", () => {
    const props = cp({
      id: "compound",
      component: "InputGroup",
      children: ["input"],
      prefix: "$",
      suffix: "USD",
    } as A2UIInputGroupComponent)
    props.renderChild = () => (
      <A2UITextField
        {...props}
        component={{ id: "amount", component: "TextField", value: "12", label: "Amount" }}
      />
    )
    render(<A2UIInputGroup {...props} />)
    const input = screen.getByRole("textbox", { name: "Amount" })
    expect(input).toHaveAttribute("data-slot", "input-group-control")
    expect(input.parentElement).toHaveAttribute("data-slot", "input-group")
    expect(screen.getByText("$").parentElement).toHaveAttribute("data-slot", "input-group-addon")
    expect(screen.getByText("USD")).toBeInTheDocument()
  })

  it("renders children", () => {
    render(
      <A2UIInputGroup
        {...cp({ id: "ig1", component: "InputGroup", children: ["input1", "addon1"] })}
      />
    )
    expect(screen.getByTestId("input1")).toBeInTheDocument()
    expect(screen.getByTestId("addon1")).toBeInTheDocument()
  })
})
