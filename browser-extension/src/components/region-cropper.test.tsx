/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

import type { BrowserApi } from "@ext/src/lib/browser-api"

import { RegionCropper } from "./region-cropper"

const api = { message: (key: string) => key } as unknown as BrowserApi

function sized(element: HTMLElement, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
}

function setup() {
  const onConfirm = jest.fn()
  const onCancel = jest.fn()
  render(
    <RegionCropper
      api={api}
      src="data:image/png;base64,AA=="
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
  const surface = screen.getByTestId("region-surface")
  sized(surface, 200, 100)
  const image = surface.querySelector("img")!
  Object.defineProperty(image, "naturalWidth", { value: 800 })
  Object.defineProperty(image, "naturalHeight", { value: 400 })
  Object.defineProperty(image, "clientWidth", { value: 200 })
  Object.defineProperty(image, "clientHeight", { value: 100 })
  return { surface, onConfirm, onCancel }
}

describe("RegionCropper", () => {
  it("maps a drag on the preview to the capture's pixels", () => {
    const { surface, onConfirm } = setup()
    fireEvent.pointerDown(surface, { clientX: 20, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(surface, { clientX: 120, clientY: 60, pointerId: 1 })
    fireEvent.pointerUp(surface, { pointerId: 1 })
    expect(screen.getByTestId("region-box")).toHaveStyle({
      left: "20px",
      top: "10px",
      width: "100px",
      height: "50px",
    })
    fireEvent.click(screen.getByTestId("region-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ x: 80, y: 40, width: 400, height: 200 })
  })

  it("takes the whole capture when nothing was dragged, and cancels", () => {
    const { onConfirm, onCancel } = setup()
    fireEvent.click(screen.getByTestId("region-confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 400 })
    fireEvent.click(screen.getByTestId("region-cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})
