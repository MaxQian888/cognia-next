/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"

import { ImageBlock } from "./image-block"

jest.mock("@/lib/files/download", () => ({
  downloadFromUrl: jest.fn(async () => undefined),
}))

const messages = {
  chat: {
    renderers: {
      image: {
        failedToLoad: "Failed to load image",
        openUrl: "Open URL",
        viewFullscreen: "View fullscreen",
        download: "Download",
        copyUrl: "Copy URL",
        defaultTitle: "Image",
        defaultFilename: "image",
        previewDescription: "Image preview",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        rotate: "Rotate",
        openInNewTab: "Open in new tab",
        close: "Close",
      },
    },
  },
}

function renderBlock() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <ImageBlock src="https://example.com/pic.png" alt="a picture" />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function openFullscreen() {
  fireEvent.click(screen.getByAltText("a picture"))
  return screen.getByTestId("image-fullscreen-stage")
}

// jsdom has no PointerEvent constructor — fireEvent.pointerDown falls back to
// a MouseEvent and silently drops `pointerId`, which the pinch tracker keys
// on. Dispatch a MouseEvent of the pointer type with pointerId grafted on.
function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  opts: { pointerId: number; clientX?: number; clientY?: number }
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
  })
  Object.defineProperty(event, "pointerId", { value: opts.pointerId })
  fireEvent(el, event)
}

describe("ImageBlock", () => {
  it("renders the inline image", () => {
    renderBlock()
    expect(screen.getByAltText("a picture")).toBeInTheDocument()
  })

  it("opens the fullscreen viewer on image click", () => {
    renderBlock()
    openFullscreen()
    expect(screen.getByTestId("image-fullscreen-stage")).toBeInTheDocument()
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("zooms with the toolbar buttons", () => {
    renderBlock()
    openFullscreen()
    fireEvent.click(screen.getByLabelText("Zoom in"))
    expect(screen.getByText("125%")).toBeInTheDocument()
  })

  describe("touch gestures", () => {
    it("pinch-out on the stage zooms in", () => {
      renderBlock()
      const stage = openFullscreen()

      // Two pointers 100px apart → spread to 200px = 2× zoom.
      firePointer(stage, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 })
      firePointer(stage, "pointerdown", { pointerId: 2, clientX: 200, clientY: 100 })
      firePointer(stage, "pointermove", { pointerId: 2, clientX: 300, clientY: 100 })
      expect(screen.getByText("200%")).toBeInTheDocument()

      // Lifting a finger ends the pinch; further single-pointer moves no-op.
      firePointer(stage, "pointerup", { pointerId: 2 })
      firePointer(stage, "pointermove", { pointerId: 1, clientX: 500, clientY: 100 })
      expect(screen.getByText("200%")).toBeInTheDocument()
    })

    it("clamps pinch zoom to the 50%–300% range", () => {
      renderBlock()
      const stage = openFullscreen()

      firePointer(stage, "pointerdown", { pointerId: 1, clientX: 100, clientY: 100 })
      firePointer(stage, "pointerdown", { pointerId: 2, clientX: 200, clientY: 100 })
      // 10× spread would be 1000% — clamped to 300%.
      firePointer(stage, "pointermove", { pointerId: 2, clientX: 1100, clientY: 100 })
      expect(screen.getByText("300%")).toBeInTheDocument()
    })

    it("double-tap toggles between 100% and 200%", () => {
      renderBlock()
      openFullscreen()
      const imgs = screen.getAllByAltText("a picture")
      const fullscreenImg = imgs[imgs.length - 1]

      fireEvent.doubleClick(fullscreenImg)
      expect(screen.getByText("200%")).toBeInTheDocument()
      fireEvent.doubleClick(fullscreenImg)
      expect(screen.getByText("100%")).toBeInTheDocument()
    })
  })
})
