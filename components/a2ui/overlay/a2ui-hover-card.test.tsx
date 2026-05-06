import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIHoverCard, type A2UIHoverCardComponent } from "./a2ui-hover-card"
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

describe("A2UIHoverCard", () => {
  const cp = (c: A2UIHoverCardComponent): A2UIComponentProps<A2UIHoverCardComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders trigger element", () => {
    render(
      <A2UIHoverCard
        {...cp({ id: "hc1", component: "HoverCard", trigger: "avatar1", children: ["detail1"] })}
      />
    )
    expect(screen.getByTestId("avatar1")).toBeInTheDocument()
  })
})
