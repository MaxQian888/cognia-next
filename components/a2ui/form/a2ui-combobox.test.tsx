import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UICombobox, type A2UIComboboxComponent } from "./a2ui-combobox"
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

describe("A2UICombobox", () => {
  const cp = (c: A2UIComboboxComponent): A2UIComponentProps<A2UIComboboxComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders with placeholder", () => {
    render(
      <A2UICombobox
        {...cp({
          id: "cb1",
          component: "Combobox",
          options: [],
          value: "",
          placeholder: "Choose...",
        })}
      />
    )
    expect(screen.getByText("Choose...")).toBeInTheDocument()
  })

  it("renders with label", () => {
    render(
      <A2UICombobox
        {...cp({ id: "cb2", component: "Combobox", options: [], value: "", label: "Country" })}
      />
    )
    expect(screen.getByText("Country")).toBeInTheDocument()
  })

  it("renders selected value label", () => {
    render(
      <A2UICombobox
        {...cp({
          id: "cb3",
          component: "Combobox",
          options: [{ value: "us", label: "United States" }],
          value: "us",
        })}
      />
    )
    expect(screen.getAllByText("United States").length).toBeGreaterThanOrEqual(1)
  })
})
