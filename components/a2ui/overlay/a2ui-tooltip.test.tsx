import React from "react"
import { render as rtlRender, screen } from "@testing-library/react"
import { A2UIActionsCtx, A2UIDataCtx } from "@/hooks/a2ui/use-a2ui-context"
import type { A2UIActionsContextValue, A2UIDataContextValue } from "@/types/a2ui/context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { A2UITooltip, type A2UITooltipComponent } from "./a2ui-tooltip"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

const render = (node: React.ReactNode) => rtlRender(<TooltipProvider>{node}</TooltipProvider>)

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

it("preserves every child when a multi-child tooltip starts with a Button descriptor", () => {
  const props = {
    component: { id: "multi", component: "Tooltip", text: "Help", children: ["button", "extra"] },
    renderChild: (id: string) => <span>{id}</span>,
  } as A2UIComponentProps<A2UITooltipComponent>
  const actions = {
    getComponent: (id: string) =>
      id === "button" ? { id, component: "Button", text: "First", action: "first" } : undefined,
  } as unknown as A2UIActionsContextValue
  const data = {} as A2UIDataContextValue
  render(
    <A2UIActionsCtx.Provider value={actions}>
      <A2UIDataCtx.Provider value={data}>
        <A2UITooltip {...props} />
      </A2UIDataCtx.Provider>
    </A2UIActionsCtx.Provider>
  )
  expect(screen.getByText("button")).toBeInTheDocument()
  expect(screen.getByText("extra")).toBeInTheDocument()
})
