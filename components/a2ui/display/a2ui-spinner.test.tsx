import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UISpinner, type A2UISpinnerComponent } from "./a2ui-spinner"
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

describe("A2UISpinner", () => {
  const cp = (c: A2UISpinnerComponent): A2UIComponentProps<A2UISpinnerComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders with status role", () => {
    render(<A2UISpinner {...cp({ id: "s1", component: "Spinner" })} />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("renders label text", () => {
    render(<A2UISpinner {...cp({ id: "s2", component: "Spinner", label: "Loading data..." })} />)
    expect(screen.getByText("Loading data...")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    const { container } = render(
      <A2UISpinner {...cp({ id: "s3", component: "Spinner", className: "my-spinner" })} />
    )
    expect(container.querySelector(".my-spinner")).toBeInTheDocument()
  })

  it("renders small size variant", () => {
    const { container } = render(
      <A2UISpinner {...cp({ id: "s4", component: "Spinner", size: "sm" })} />
    )
    expect(container.querySelector(".size-4")).toBeInTheDocument()
  })
})
