import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIBreadcrumb, type A2UIBreadcrumbComponent } from "./a2ui-breadcrumb"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "t",
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

describe("A2UIBreadcrumb", () => {
  const cp = (c: A2UIBreadcrumbComponent): A2UIComponentProps<A2UIBreadcrumbComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders breadcrumb items", () => {
    render(
      <A2UIBreadcrumb
        {...cp({
          id: "bc1",
          component: "Breadcrumb",
          items: [
            { label: "Home", href: "/" },
            { label: "Page", current: true },
          ],
        })}
      />
    )
    expect(screen.getByText("Home")).toBeInTheDocument()
    expect(screen.getByText("Page")).toBeInTheDocument()
  })
})
