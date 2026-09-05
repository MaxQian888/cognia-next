/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { ScanRadar } from "./scan-radar"

describe("<ScanRadar />", () => {
  it("flips the data-state attribute based on active prop", () => {
    const { rerender } = render(<ScanRadar active={false} />)
    const node = screen.getByTestId("pair-scan-radar")
    expect(node).toHaveAttribute("data-state", "idle")
    rerender(<ScanRadar active />)
    expect(screen.getByTestId("pair-scan-radar")).toHaveAttribute("data-state", "active")
  })

  it("hides itself from assistive technology", () => {
    render(<ScanRadar active />)
    expect(screen.getByTestId("pair-scan-radar")).toHaveAttribute("aria-hidden", "true")
  })

  it("toggles the radar-ring active class only when scanning", () => {
    const { rerender } = render(<ScanRadar active={false} />)
    const ringsIdle = screen.getByTestId("pair-scan-radar").querySelectorAll(".pair-radar-ring")
    expect(ringsIdle.length).toBeGreaterThan(0)
    ringsIdle.forEach((r) => expect(r.className).not.toMatch(/pair-radar-ring--active/))
    rerender(<ScanRadar active />)
    const ringsActive = screen
      .getByTestId("pair-scan-radar")
      .querySelectorAll(".pair-radar-ring--active")
    expect(ringsActive.length).toBeGreaterThan(0)
  })

  it("breathes the centre badge only while scanning", () => {
    const { rerender } = render(<ScanRadar active={false} />)
    expect(
      screen.getByTestId("pair-scan-radar").querySelector(".pair-radar-core--active")
    ).toBeNull()
    rerender(<ScanRadar active />)
    expect(
      screen.getByTestId("pair-scan-radar").querySelector(".pair-radar-core--active")
    ).not.toBeNull()
  })
})
