import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import { BrowserZoomControl, ZOOM_STEPS, zoomIn, zoomOut } from "./browser-zoom-control"

const renderControl = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)
const TOP = ZOOM_STEPS[ZOOM_STEPS.length - 1]

describe("zoom step helpers", () => {
  it("steps up to the next stop and holds at the top", () => {
    expect(zoomIn(1)).toBe(1.1)
    expect(zoomIn(0.9)).toBe(1)
    expect(zoomIn(TOP)).toBe(TOP)
  })

  it("steps down to the previous stop and holds at the bottom", () => {
    expect(zoomOut(1)).toBe(0.9)
    expect(zoomOut(1.1)).toBe(1)
    expect(zoomOut(ZOOM_STEPS[0])).toBe(ZOOM_STEPS[0])
  })

  it("snaps an off-grid value onto the nearest stop in each direction", () => {
    expect(zoomIn(0.25)).toBe(0.5)
    expect(zoomOut(0.25)).toBe(0.25)
  })
})

describe("BrowserZoomControl", () => {
  it("shows the current zoom as a percentage on the reset button", () => {
    renderControl(<BrowserZoomControl zoom={1.5} onZoomChange={jest.fn()} />)
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("150%")
  })

  it("steps in, out, and resets to 100%", () => {
    const onZoomChange = jest.fn()
    renderControl(<BrowserZoomControl zoom={1} onZoomChange={onZoomChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(onZoomChange).toHaveBeenLastCalledWith(1.1)
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }))
    expect(onZoomChange).toHaveBeenLastCalledWith(0.9)
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }))
    expect(onZoomChange).toHaveBeenLastCalledWith(1)
  })

  it("disables the minus button at the smallest stop", () => {
    renderControl(<BrowserZoomControl zoom={ZOOM_STEPS[0]} onZoomChange={jest.fn()} />)
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeEnabled()
  })

  it("disables the plus button at the largest stop", () => {
    renderControl(<BrowserZoomControl zoom={TOP} onZoomChange={jest.fn()} />)
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled()
  })

  it("disables every control when disabled", () => {
    renderControl(<BrowserZoomControl zoom={1} onZoomChange={jest.fn()} disabled />)
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Reset zoom" })).toBeDisabled()
  })
})
