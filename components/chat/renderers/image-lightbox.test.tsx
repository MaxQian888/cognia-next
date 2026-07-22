/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useRef, useState } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { downloadFromUrl } from "@/lib/files/download"
import { openExternal } from "@/lib/tauri/opener"

import { ImageLightbox, type ImageLightboxItem } from "./image-lightbox"

const mockUseReducedMotion = jest.fn(() => false)

jest.mock("motion/react", () => ({
  ...jest.requireActual("../../../__mocks__/motion-react.js"),
  useReducedMotion: () => mockUseReducedMotion(),
}))

jest.mock("@/lib/files/download", () => ({
  downloadFromUrl: jest.fn(async () => undefined),
}))

jest.mock("@/lib/tauri/opener", () => ({
  openExternal: jest.fn(async () => undefined),
}))

const mockDownloadFromUrl = jest.mocked(downloadFromUrl)
const mockOpenExternal = jest.mocked(openExternal)

const items: ImageLightboxItem[] = [
  { id: "one", src: "https://example.com/one.png", alt: "First image", filename: "one.png" },
  { id: "two", src: "https://example.com/two.png", alt: "Second image", filename: "two.png" },
]

const messages = {
  chat: {
    renderers: {
      image: {
        close: "Close",
        counter: "{current} of {total}",
        defaultFilename: "image",
        defaultTitle: "Image",
        download: "Download",
        failedToLoad: "Failed to load image",
        next: "Next image",
        openInNewTab: "Open in new tab",
        previewDescription: "Image preview",
        previous: "Previous image",
        rotate: "Rotate",
        selectImage: "View {name}",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
      },
    },
  },
}

function GalleryHarness() {
  const [activeIndex, setActiveIndex] = useState(0)
  return (
    <ImageLightbox
      items={items}
      open
      activeIndex={activeIndex}
      onActiveIndexChange={setActiveIndex}
      onOpenChange={jest.fn()}
    />
  )
}

function renderGallery() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <GalleryHarness />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function FocusHarness() {
  const [open, setOpen] = useState(false)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <button ref={returnFocusRef} type="button" onClick={() => setOpen(true)}>
        Open preview
      </button>
      <ImageLightbox
        items={items}
        open={open}
        activeIndex={0}
        returnFocusRef={returnFocusRef}
        onActiveIndexChange={jest.fn()}
        onOpenChange={setOpen}
      />
    </>
  )
}

describe("ImageLightbox", () => {
  beforeEach(() => {
    mockDownloadFromUrl.mockClear()
    mockDownloadFromUrl.mockResolvedValue(undefined)
    mockOpenExternal.mockClear()
    mockOpenExternal.mockResolvedValue(undefined)
    mockUseReducedMotion.mockReturnValue(false)
  })

  it("navigates the gallery from thumbnails and arrow keys", () => {
    renderGallery()

    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[0].src)
    expect(screen.getByText("1 of 2")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "View two.png" }))
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[1].src)
    expect(screen.getByText("2 of 2")).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" })
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[0].src)

    fireEvent.click(screen.getByRole("button", { name: "Next image" }))
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[1].src)
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" })
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[1].src)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Home" })
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[0].src)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "End" })
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveAttribute("src", items[1].src)
  })

  it("keeps zoom and rotation controls available in the focused viewer", () => {
    renderGallery()

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    expect(screen.getByText("125%")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Rotate" }))
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveStyle({
      transform: "scale(1.25) rotate(90deg)",
    })

    fireEvent.click(screen.getByTestId("image-lightbox-stage"))
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(screen.getByTestId("image-lightbox-active-image")).toHaveStyle({
      transform: "scale(1) rotate(0deg)",
    })
  })

  it("downloads and opens the active image externally", async () => {
    renderGallery()

    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    await waitFor(() =>
      expect(mockDownloadFromUrl).toHaveBeenCalledWith(items[0].src, "one.png", {
        fetchAsBlob: true,
      })
    )

    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }))
    expect(mockOpenExternal).toHaveBeenCalledWith(items[0].src)
  })

  it("falls back to opening externally when download fails", async () => {
    mockDownloadFromUrl.mockRejectedValueOnce(new Error("save failed"))
    renderGallery()

    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalledWith(items[0].src))
  })

  it("does not offer external opening for WebView-local image URLs", async () => {
    mockDownloadFromUrl.mockRejectedValueOnce("save failed")
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TooltipProvider>
          <ImageLightbox
            items={[{ id: "local", src: "blob:local-image", filename: "local.png" }]}
            open
            activeIndex={0}
            onActiveIndexChange={jest.fn()}
            onOpenChange={jest.fn()}
          />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Download" }))
    await waitFor(() => expect(mockDownloadFromUrl).toHaveBeenCalled())
    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it("handles external viewer failures without an unhandled rejection", async () => {
    mockOpenExternal.mockRejectedValueOnce("blocked")
    renderGallery()

    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }))

    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalledWith(items[0].src))
  })

  it("shows a localized error state when the image fails to load", () => {
    renderGallery()

    fireEvent.error(screen.getByTestId("image-lightbox-active-image"))

    expect(screen.getByRole("status")).toHaveTextContent("Failed to load image")
  })

  it("clamps indexes and uses metadata fallbacks for labels and downloads", async () => {
    const fallbackItems: ImageLightboxItem[] = [
      items[0],
      { id: "title", src: "https://example.com/title.png", title: "Title only" },
      { id: "alt", src: "https://example.com/alt.png", alt: "Alt only" },
      { id: "default", src: "https://example.com/" },
    ]
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TooltipProvider>
          <ImageLightbox
            items={fallbackItems}
            open
            activeIndex={99}
            onActiveIndexChange={jest.fn()}
            onOpenChange={jest.fn()}
          />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

    expect(screen.getByRole("heading", { name: "Image" })).toBeInTheDocument()
    expect(screen.getByText("4 of 4")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View Title only" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View Alt only" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Download" }))

    await waitFor(() =>
      expect(mockDownloadFromUrl).toHaveBeenCalledWith("https://example.com/", "image", {
        fetchAsBlob: true,
      })
    )
  })

  it("keeps zoom within the supported limits", () => {
    renderGallery()
    const zoomOut = screen.getByRole("button", { name: "Zoom out" })
    const zoomIn = screen.getByRole("button", { name: "Zoom in" })

    fireEvent.click(zoomOut)
    fireEvent.click(zoomOut)
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(zoomOut).toBeDisabled()

    for (let index = 0; index < 10; index += 1) fireEvent.click(zoomIn)
    expect(screen.getByText("300%")).toBeInTheDocument()
    expect(zoomIn).toBeDisabled()
  })

  it("honors reduced-motion preferences", () => {
    mockUseReducedMotion.mockReturnValue(true)

    renderGallery()
    expect(screen.getByTestId("image-lightbox-active-image")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View two.png" }))
  })

  it("renders nothing for an empty gallery", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImageLightbox
          items={[]}
          open
          activeIndex={12}
          onActiveIndexChange={jest.fn()}
          onOpenChange={jest.fn()}
        />
      </NextIntlClientProvider>
    )

    expect(container).toBeEmptyDOMElement()
  })

  it("returns focus to the thumbnail that opened the preview", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TooltipProvider>
          <FocusHarness />
        </TooltipProvider>
      </NextIntlClientProvider>
    )

    const trigger = screen.getByRole("button", { name: "Open preview" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
