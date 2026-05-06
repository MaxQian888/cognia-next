import React from "react"
import { render, screen } from "@testing-library/react"
import type { A2UIComponentProps } from "@/types/a2ui/schema"

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
})

jest.mock("../a2ui-context", () => ({
  useA2UIContext: () => ({
    surfaceId: "t",
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

import { A2UICarousel, type A2UICarouselComponent } from "./a2ui-carousel"

describe("A2UICarousel", () => {
  const cp = (c: A2UICarouselComponent): A2UIComponentProps<A2UICarouselComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn((id: string) => <span data-testid={id}>{id}</span>),
  })

  it("renders children as slides", () => {
    render(
      <A2UICarousel {...cp({ id: "ca1", component: "Carousel", children: ["slide1", "slide2"] })} />
    )
    expect(screen.getByTestId("slide1")).toBeInTheDocument()
    expect(screen.getByTestId("slide2")).toBeInTheDocument()
  })
})
