import React from "react"
import { render, screen } from "@testing-library/react"
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
