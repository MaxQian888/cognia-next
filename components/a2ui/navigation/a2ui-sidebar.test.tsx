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
    renderChild: jest.fn(),
  }),
  useA2UIData: () => ({
    resolveString: (v: unknown) => (typeof v === "string" ? v : ""),
    resolveNumber: (v: unknown) => (typeof v === "number" ? v : 0),
    resolveBoolean: (v: unknown) => (typeof v === "boolean" ? v : false),
    resolveArray: <T,>(v: unknown, d: T[] = []) => (Array.isArray(v) ? v : d),
  }),
}))

import { A2UISidebar, type A2UISidebarComponent } from "./a2ui-sidebar"

describe("A2UISidebar", () => {
  const cp = (c: A2UISidebarComponent): A2UIComponentProps<A2UISidebarComponent> => ({
    component: c,
    surfaceId: "t",
    dataModel: {},
    onAction: jest.fn(),
    onDataChange: jest.fn(),
    renderChild: jest.fn(),
  })

  it("renders nav items", () => {
    render(
      <A2UISidebar
        {...cp({
          id: "sb1",
          component: "Sidebar",
          groups: [
            {
              id: "main",
              items: [
                { id: "home", label: "Home" },
                { id: "settings", label: "Settings" },
              ],
            },
          ],
        })}
      />
    )
    expect(screen.getByText("Home")).toBeInTheDocument()
    expect(screen.getByText("Settings")).toBeInTheDocument()
  })

  it("renders header and footer", () => {
    render(
      <A2UISidebar
        {...cp({
          id: "sb2",
          component: "Sidebar",
          groups: [],
          header: "My App",
          footer: "v1.0.0",
        })}
      />
    )
    expect(screen.getByText("My App")).toBeInTheDocument()
    expect(screen.getByText("v1.0.0")).toBeInTheDocument()
  })
})
