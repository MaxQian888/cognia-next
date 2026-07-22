/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import { downloadFromUrl } from "@/lib/files/download"
import { openExternal } from "@/lib/tauri/opener"

import { ImageBlock } from "./image-block"

const mockCopy = jest.fn(async () => undefined)
let mockCopied = false

jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: mockCopied, copy: mockCopy }),
}))

jest.mock("@/lib/files/download", () => ({
  downloadFromUrl: jest.fn(async () => undefined),
}))

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn(async () => undefined),
}))

const mockDownloadFromUrl = jest.mocked(downloadFromUrl)
const mockOpenExternal = jest.mocked(openExternal)

const messages = {
  chat: {
    renderers: {
      image: {
        failedToLoad: "Failed to load image",
        openUrl: "Open URL",
        viewFullscreen: "View fullscreen",
        download: "Download",
        copyUrl: "Copy URL",
        counter: "{current} of {total}",
        defaultTitle: "Image",
        defaultFilename: "image",
        previewDescription: "Image preview",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        rotate: "Rotate",
        selectImage: "View {name}",
        openInNewTab: "Open in new tab",
        close: "Close",
      },
    },
  },
}

function renderBlock({
  src = "https://example.com/pic.png",
  alt = "a picture",
  title,
}: {
  src?: string
  alt?: string
  title?: string
} = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <ImageBlock src={src} alt={alt} title={title} />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function openFullscreen() {
  fireEvent.click(screen.getByAltText("a picture"))
  return screen.getByTestId("image-lightbox-stage")
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
  beforeEach(() => {
    mockDownloadFromUrl.mockClear()
    mockDownloadFromUrl.mockResolvedValue(undefined)
    mockOpenExternal.mockClear()
    mockCopy.mockClear()
    mockCopied = false
  })

  it("renders the inline image", () => {
    const { container } = renderBlock()
    const image = screen.getByAltText("a picture")
    expect(image).toBeInTheDocument()
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument()

    fireEvent.load(image)

    expect(container.querySelector(".animate-pulse")).not.toBeInTheDocument()
  })

  it("opens the fullscreen viewer on image click", () => {
    renderBlock()
    openFullscreen()
    expect(screen.getByTestId("image-lightbox-stage")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View a picture" })).toBeInTheDocument()
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("zooms with the toolbar buttons", () => {
    renderBlock()
    openFullscreen()
    fireEvent.click(screen.getByLabelText("Zoom in"))
    expect(screen.getByText("125%")).toBeInTheDocument()
  })

  it("opens from the keyboard and restores focus after closing", async () => {
    renderBlock()
    const image = screen.getByAltText("a picture")
    image.focus()

    fireEvent.keyDown(image, { key: "x" })
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.keyDown(image, { key: " " })
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() => expect(image).toHaveFocus())
  })

  it("opens from the fullscreen toolbar button and restores focus", async () => {
    renderBlock()
    const trigger = screen
      .getAllByRole("button", { name: "View fullscreen" })
      .find((element) => element.tagName === "BUTTON")!

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("downloads and copies the inline image", async () => {
    renderBlock()

    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }))

    await waitFor(() =>
      expect(mockDownloadFromUrl).toHaveBeenCalledWith("https://example.com/pic.png", "pic.png", {
        fetchAsBlob: true,
      })
    )
    expect(mockCopy).toHaveBeenCalledWith("https://example.com/pic.png")
  })

  it("shows copied feedback and title-based captions", () => {
    mockCopied = true
    renderBlock({ alt: "", title: "Generated chart" })

    expect(screen.getByText("Generated chart")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Copy URL" }).querySelector(".lucide-check")
    ).toBeInTheDocument()
  })

  it("uses the default download name and omits an empty caption", async () => {
    const { container } = renderBlock({ src: "https://example.com/", alt: "" })

    expect(container.querySelector("figcaption")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    await waitFor(() =>
      expect(mockDownloadFromUrl).toHaveBeenCalledWith("https://example.com/", "image", {
        fetchAsBlob: true,
      })
    )
  })

  it("falls back to the external viewer when download fails", async () => {
    mockDownloadFromUrl.mockRejectedValueOnce("save failed")
    renderBlock()

    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    await waitFor(() =>
      expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/pic.png")
    )
  })

  it("handles Error download failures before opening externally", async () => {
    mockDownloadFromUrl.mockRejectedValueOnce(new Error("save failed"))
    renderBlock()

    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    await waitFor(() =>
      expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/pic.png")
    )
  })

  it("shows the inline error state and lets the user open the source", () => {
    renderBlock()

    fireEvent.error(screen.getByAltText("a picture"))
    expect(screen.getByText("Failed to load image")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open URL" }))

    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/pic.png")
  })

  it("omits absent alt text from the inline error state", () => {
    renderBlock({ alt: "" })

    const image = screen
      .getAllByRole("button", { name: "View fullscreen" })
      .find((element) => element.tagName === "IMG")!
    fireEvent.error(image)

    expect(screen.getByText("Failed to load image")).toBeInTheDocument()
    expect(screen.queryByText("a picture")).not.toBeInTheDocument()
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
