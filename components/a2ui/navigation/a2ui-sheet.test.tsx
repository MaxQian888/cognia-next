import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UISheet, type A2UISheetComponent } from "./a2ui-sheet"
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

describe("A2UISheet", () => {
  const cp = (c: A2UISheetComponent): A2UIComponentProps<A2UISheetComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders trigger element", () => {
    render(
      <A2UISheet {...cp({ id: "sh1", component: "Sheet", trigger: "open-btn", children: [] })} />
    )
    expect(screen.getByTestId("open-btn")).toBeInTheDocument()
  })
})
