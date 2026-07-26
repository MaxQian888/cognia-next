/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"

import { ImageBlock } from "./image-block"
import { MessageImageGallery } from "./message-image-gallery"
import {
  MessageImageCollectionProvider,
  useMessageImageCollection,
} from "./message-image-collection"

jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy: jest.fn(async () => undefined) }),
}))
jest.mock("@/lib/files/download", () => ({ downloadFromUrl: jest.fn(async () => undefined) }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => undefined) }))

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
        galleryAria: "{count} images",
        previewAria: "View {name}",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        rotate: "Rotate",
        selectImage: "View {name}",
        openInNewTab: "Open in new tab",
        close: "Close",
        previous: "Previous",
        next: "Next",
      },
    },
  },
}

function withProviders(node: React.ReactNode, { collection = true } = {}) {
  const body = collection ? (
    <MessageImageCollectionProvider>{node}</MessageImageCollectionProvider>
  ) : (
    node
  )
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>{body}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("MessageImageCollectionProvider", () => {
  it("renders nothing extra until an image is opened", () => {
    withProviders(<ImageBlock src="https://x.test/a.png" alt="a" />)
    expect(screen.queryByTestId("image-lightbox-stage")).not.toBeInTheDocument()
  })

  it("pages a single lightbox across every image in the message", () => {
    withProviders(
      <>
        <ImageBlock src="https://x.test/a.png" alt="first" />
        <ImageBlock src="https://x.test/b.png" alt="second" />
        <ImageBlock src="https://x.test/c.png" alt="third" />
      </>
    )

    // Exactly one lightbox exists for the whole message, not one per block.
    fireEvent.click(screen.getByAltText("second"))
    expect(screen.getAllByTestId("image-lightbox-stage")).toHaveLength(1)
    // ...and it opened on the image that was actually clicked.
    expect(screen.getByText("2 of 3")).toBeInTheDocument()
  })

  it("merges attachment-gallery images into the same set as markdown images", () => {
    withProviders(
      <>
        <MessageImageGallery
          items={[{ id: "att", src: "https://x.test/att.png", alt: "attached" }]}
        />
        <ImageBlock src="https://x.test/inline.png" alt="inline" />
      </>
    )

    fireEvent.click(screen.getByAltText("inline"))
    // Gallery registered first, so the inline image is #2 of a 2-image set.
    expect(screen.getByText("2 of 2")).toBeInTheDocument()
  })

  it("dedupes by src so the same image registered twice appears once", () => {
    withProviders(
      <>
        <ImageBlock src="https://x.test/same.png" alt="one" />
        <ImageBlock src="https://x.test/same.png" alt="two" />
      </>
    )
    fireEvent.click(screen.getByAltText("one"))
    expect(screen.getByText("1 of 1")).toBeInTheDocument()
  })

  it("drops an image from the set when its block unmounts", () => {
    function Harness({ showSecond }: { showSecond: boolean }) {
      return (
        <MessageImageCollectionProvider>
          <ImageBlock src="https://x.test/a.png" alt="first" />
          {showSecond ? <ImageBlock src="https://x.test/b.png" alt="second" /> : null}
        </MessageImageCollectionProvider>
      )
    }
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TooltipProvider>
          <Harness showSecond />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TooltipProvider>
          <Harness showSecond={false} />
        </TooltipProvider>
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByAltText("first"))
    expect(screen.getByText("1 of 1")).toBeInTheDocument()
  })

  it("is a no-op when nothing has registered", () => {
    function Opener() {
      const collection = useMessageImageCollection()
      return (
        <button type="button" onClick={() => collection?.open("https://x.test/ghost.png", null)}>
          open
        </button>
      )
    }
    withProviders(<Opener />)
    fireEvent.click(screen.getByRole("button", { name: "open" }))
    expect(screen.queryByTestId("image-lightbox-stage")).not.toBeInTheDocument()
  })

  it("falls back to the first image when the requested src is not in the set", () => {
    function Opener() {
      const collection = useMessageImageCollection()
      return (
        <button type="button" onClick={() => collection?.open("https://x.test/ghost.png", null)}>
          open
        </button>
      )
    }
    withProviders(
      <>
        <ImageBlock src="https://x.test/a.png" alt="first" />
        <Opener />
      </>
    )
    fireEvent.click(screen.getByRole("button", { name: "open" }))
    expect(screen.getByText("1 of 1")).toBeInTheDocument()
  })
})

describe("without a provider", () => {
  it("ImageBlock keeps its own local lightbox", () => {
    withProviders(<ImageBlock src="https://x.test/a.png" alt="lonely" />, { collection: false })
    fireEvent.click(screen.getByAltText("lonely"))
    expect(screen.getByTestId("image-lightbox-stage")).toBeInTheDocument()
  })

  it("useMessageImageCollection returns null outside a message", () => {
    let seen: unknown = "unset"
    function Probe() {
      seen = useMessageImageCollection()
      return null
    }
    withProviders(<Probe />, { collection: false })
    expect(seen).toBeNull()
  })
})
