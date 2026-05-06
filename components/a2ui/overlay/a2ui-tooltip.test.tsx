import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UITooltip, type A2UITooltipComponent } from "./a2ui-tooltip"
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

describe("A2UITooltip", () => {
  const cp = (c: A2UITooltipComponent): A2UIComponentProps<A2UITooltipComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders trigger children", () => {
    render(
      <A2UITooltip
        {...cp({ id: "tt1", component: "Tooltip", text: "Help", children: ["child1"] })}
      />
    )
    expect(screen.getByTestId("child1")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    const { container } = render(
      <A2UITooltip
        {...cp({
          id: "tt2",
          component: "Tooltip",
          text: "Info",
          children: ["c1"],
          className: "my-tooltip",
        })}
      />
    )
    expect(container.querySelector(".my-tooltip")).toBeInTheDocument()
  })
})
