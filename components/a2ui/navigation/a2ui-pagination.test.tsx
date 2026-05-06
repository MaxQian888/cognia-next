import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UIPagination, type A2UIPaginationComponent } from "./a2ui-pagination"
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

describe("A2UIPagination", () => {
  const cp = (c: A2UIPaginationComponent): A2UIComponentProps<A2UIPaginationComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders page numbers", () => {
    render(
      <A2UIPagination
        {...cp({ id: "p1", component: "Pagination", currentPage: 1, totalPages: 5 })}
      />
    )
    expect(screen.getByText("1")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
  })

  it("returns null for single page", () => {
    const { container } = render(
      <A2UIPagination
        {...cp({ id: "p2", component: "Pagination", currentPage: 1, totalPages: 1 })}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
