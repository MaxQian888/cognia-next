import userEvent from "@testing-library/user-event"
import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIDropdownMenu, type A2UIDropdownMenuComponent } from "./a2ui-dropdown-menu"
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

describe("A2UIDropdownMenu", () => {
  const cp = (c: A2UIDropdownMenuComponent): A2UIComponentProps<A2UIDropdownMenuComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders trigger element", () => {
    render(
      <A2UIDropdownMenu
        {...cp({
          id: "dm1",
          component: "DropdownMenu",
          trigger: "menu-btn",
          items: [{ id: "i1", label: "Edit", action: "edit" }],
        })}
      />
    )
    expect(screen.getByTestId("menu-btn")).toBeInTheDocument()
  })
})

it("keeps the actual trigger interactive with the native overlay", async () => {
  const props = {
    component: {
      id: "keyboard",
      component: "DropdownMenu",
      trigger: "trigger",
      items: [{ id: "choice", label: "Choose item", action: "choose" }],
    },
    surfaceId: "s",
    dataModel: {},
    onDataChange: jest.fn(),
    onAction: jest.fn(),
    renderChild: (id: string) =>
      id === "trigger" ? <button>Open panel</button> : <p>Panel content</p>,
  } as A2UIComponentProps<A2UIDropdownMenuComponent>
  render(<A2UIDropdownMenu {...props} />)
  const trigger = screen.getByRole("button", { name: "Open panel" })
  trigger.focus()
  await userEvent.keyboard("{ArrowDown}")
  expect(await screen.findByRole("menuitem", { name: "Choose item" })).toBeVisible()
  await userEvent.keyboard("{Enter}")
  expect(props.onAction).toHaveBeenCalledWith("choose", {})
})
