import React from "react"
import { render, screen } from "@testing-library/react"
import { A2UISkeleton, type A2UISkeletonComponent } from "./a2ui-skeleton"
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

describe("A2UISkeleton", () => {
  const cp = (c: A2UISkeletonComponent): A2UIComponentProps<A2UISkeletonComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders single skeleton", () => {
    render(<A2UISkeleton {...cp({ id: "sk1", component: "Skeleton" })} />)
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("renders circular variant", () => {
    render(<A2UISkeleton {...cp({ id: "sk2", component: "Skeleton", variant: "circular" })} />)
    const el = screen.getByRole("status")
    expect(el).toHaveClass("rounded-full")
  })

  it("renders multiple text lines", () => {
    const { container } = render(
      <A2UISkeleton {...cp({ id: "sk3", component: "Skeleton", variant: "text", lines: 3 })} />
    )
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3)
  })
})
