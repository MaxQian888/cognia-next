import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { A2UITrigger } from "./a2ui-child-renderer"
import { A2UIActionsCtx, A2UIDataCtx } from "@/hooks/a2ui/use-a2ui-context"
import type { A2UIActionsContextValue, A2UIDataContextValue } from "@/types/a2ui/context"

it("attaches primitive trigger semantics and ref to the actual A2UI button", () => {
  const emitAction = jest.fn()
  const triggerClick = jest.fn()
  const ref = React.createRef<HTMLElement>()
  const actions = {
    surfaceId: "s",
    getComponent: () => ({ id: "button", component: "Button", text: "Open", action: "open" }),
    emitAction,
    setDataValue: jest.fn(),
    renderChild: () => null,
  } as unknown as A2UIActionsContextValue
  const data = {
    dataModel: {},
    resolveString: (value: unknown) => (typeof value === "string" ? value : ""),
    resolveBoolean: (value: unknown) => Boolean(value),
  } as unknown as A2UIDataContextValue
  render(
    <A2UIActionsCtx.Provider value={actions}>
      <A2UIDataCtx.Provider value={data}>
        <A2UITrigger
          componentId="button"
          renderChild={() => null}
          ref={ref}
          aria-expanded={false}
          onClick={triggerClick}
        />
      </A2UIDataCtx.Provider>
    </A2UIActionsCtx.Provider>
  )
  const button = screen.getByRole("button", { name: "Open" })
  expect(button).toHaveAttribute("aria-expanded", "false")
  expect(ref.current).toBe(button)
  fireEvent.click(button)
  expect(triggerClick).toHaveBeenCalledTimes(1)
  expect(emitAction).toHaveBeenCalledWith("open", "button", { text: "Open" })
})

it("does not expose a trigger hidden by its descriptor", () => {
  const actions = {
    getComponent: () => ({ id: "hidden", component: "Button", text: "Hidden", visible: false }),
  } as unknown as A2UIActionsContextValue
  const data = { resolveBoolean: () => false } as unknown as A2UIDataContextValue
  render(
    <A2UIActionsCtx.Provider value={actions}>
      <A2UIDataCtx.Provider value={data}>
        <A2UITrigger componentId="hidden" renderChild={() => null} />
      </A2UIDataCtx.Provider>
    </A2UIActionsCtx.Provider>
  )
  expect(screen.queryByText("Hidden")).not.toBeInTheDocument()
})
