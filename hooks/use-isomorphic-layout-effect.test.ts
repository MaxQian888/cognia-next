/** @jest-environment jsdom */

import { useEffect, useLayoutEffect } from "react"
import { renderHook } from "@testing-library/react"

import { useIsomorphicLayoutEffect } from "./use-isomorphic-layout-effect"

describe("useIsomorphicLayoutEffect", () => {
  it("is the layout variant when a DOM is present", () => {
    expect(useIsomorphicLayoutEffect).toBe(useLayoutEffect)
    expect(useIsomorphicLayoutEffect).not.toBe(useEffect)
  })

  it("runs before the browser would paint, i.e. synchronously with the commit", () => {
    const order: string[] = []
    renderHook(() => {
      useEffect(() => {
        order.push("passive")
      }, [])
      useIsomorphicLayoutEffect(() => {
        order.push("layout")
      }, [])
    })
    expect(order).toEqual(["layout", "passive"])
  })
})
