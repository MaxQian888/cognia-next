import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIContextMenu, type A2UIContextMenuComponent } from "./a2ui-context-menu"
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

describe("A2UIContextMenu", () => {
  const cp = (c: A2UIContextMenuComponent): A2UIComponentProps<A2UIContextMenuComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders trigger element", () => {
    render(
      <A2UIContextMenu
        {...cp({
          id: "cm1",
          component: "ContextMenu",
          trigger: "card1",
          items: [{ id: "i1", label: "Copy", action: "copy" }],
        })}
      />
    )
    expect(screen.getByTestId("card1")).toBeInTheDocument()
  })
})
