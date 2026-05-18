/**
 * @jest-environment jsdom
 */

import { render, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { SkillPanelProvider, useSkillPanel } from "./skill-panel-context"

describe("SkillPanelContext", () => {
  it("returns an empty object when no provider is in scope", () => {
    const { result } = renderHook(() => useSkillPanel())
    expect(result.current).toEqual({})
  })

  it("exposes the provided className and embedded flag", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SkillPanelProvider className="custom" embedded>
        {children}
      </SkillPanelProvider>
    )
    const { result } = renderHook(() => useSkillPanel(), { wrapper })
    expect(result.current.className).toBe("custom")
    expect(result.current.embedded).toBe(true)
  })

  it("defaults embedded to undefined when not supplied", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SkillPanelProvider>{children}</SkillPanelProvider>
    )
    const { result } = renderHook(() => useSkillPanel(), { wrapper })
    expect(result.current.embedded).toBeUndefined()
    expect(result.current.className).toBeUndefined()
  })

  it("renders provider children", () => {
    const { getByText } = render(
      <SkillPanelProvider>
        <span>child node</span>
      </SkillPanelProvider>
    )
    expect(getByText("child node")).toBeInTheDocument()
  })
})
