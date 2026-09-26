/**
 * @jest-environment jsdom
 */

import { createElement, type ReactNode } from "react"
import { renderHook } from "@testing-library/react"

import { OverlaySideContext, overlaySideFor, useOverlaySide } from "./rail-overlay-side"

describe("overlaySideFor", () => {
  it("opens inward from either edge", () => {
    expect(overlaySideFor("left")).toBe("right")
    expect(overlaySideFor("right")).toBe("left")
  })
})

describe("useOverlaySide", () => {
  it("defaults to the left rail's rightward overlays outside a provider", () => {
    expect(renderHook(() => useOverlaySide()).result.current).toBe("right")
  })

  it("reads the provided side", () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(OverlaySideContext.Provider, { value: "left" }, children)
    expect(renderHook(() => useOverlaySide(), { wrapper }).result.current).toBe("left")
  })
})
