import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIDrawer, type A2UIDrawerComponent } from "./a2ui-drawer"
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

describe("A2UIDrawer", () => {
  const cp = (c: A2UIDrawerComponent): A2UIComponentProps<A2UIDrawerComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders trigger element", () => {
    render(
      <A2UIDrawer {...cp({ id: "d1", component: "Drawer", trigger: "menu-btn", children: [] })} />
    )
    expect(screen.getByTestId("menu-btn")).toBeInTheDocument()
  })
})
