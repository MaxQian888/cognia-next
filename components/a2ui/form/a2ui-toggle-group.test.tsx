import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIToggleGroup, type A2UIToggleGroupComponent } from "./a2ui-toggle-group"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "test",
    dataModel: {},
    catalog: undefined,
    emitAction: jest.fn(),
    setDataValue: jest.fn(),
    renderChild: jest.fn(),
  }),
  useA2UIData: () => ({
    resolveString: (v: unknown) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: unknown) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: unknown) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: unknown, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
}))

jest.mock("@/lib/a2ui/data-model", () => ({
  getBindingPath: (v: unknown) => {
    if (typeof v === "object" && v !== null && "path" in v) return (v as { path: string }).path
    return undefined
  },
}))

describe("A2UIToggleGroup", () => {
  const cp = (c: A2UIToggleGroupComponent): A2UIComponentProps<A2UIToggleGroupComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders options", () => {
    render(
      <A2UIToggleGroup
        {...cp({
          id: "tg1",
          component: "ToggleGroup",
          options: [
            { value: "a", label: "Option A" },
            { value: "b", label: "Option B" },
          ],
          value: [],
        })}
      />
    )
    expect(screen.getByText("Option A")).toBeInTheDocument()
    expect(screen.getByText("Option B")).toBeInTheDocument()
  })

  it("renders with label", () => {
    render(
      <A2UIToggleGroup
        {...cp({
          id: "tg2",
          component: "ToggleGroup",
          options: [{ value: "1", label: "One" }],
          value: [],
          label: "Numbers",
        })}
      />
    )
    expect(screen.getByText("Numbers")).toBeInTheDocument()
  })
})
