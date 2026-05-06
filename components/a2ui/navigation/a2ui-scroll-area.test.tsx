import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIScrollArea, type A2UIScrollAreaComponent } from "./a2ui-scroll-area"
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

describe("A2UIScrollArea", () => {
  const cp = (c: A2UIScrollAreaComponent): A2UIComponentProps<A2UIScrollAreaComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders children", () => {
    render(
      <A2UIScrollArea {...cp({ id: "sa1", component: "ScrollArea", children: ["content1"] })} />
    )
    expect(screen.getByTestId("content1")).toBeInTheDocument()
  })
})
