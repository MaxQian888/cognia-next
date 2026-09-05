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

/**
 * The workbench half of the provider. The workbench itself is mocked to a prop
 * recorder, because what matters here is the translation the provider performs:
 * the renderer only ever knew the object URL it painted, and the workbench
 * needs the message part's url to attach a version to the right lineage.
 */
jest.mock("@/components/chat/image-workbench/image-workbench", () => ({
  ImageWorkbench: (props: Record<string, unknown>) => {
    workbenchProps = props
    return <div data-testid="mock-workbench" />
  },
}))

const liveQueryValue: { current: unknown } = { current: null }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveQueryValue.current,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get: jest.fn() } }) }))

let workbenchProps: Record<string, unknown> = {}

const IMAGE_EDIT = "cogniaImageEdit"
const parts = [
  { type: "file", url: "https://example.com/origin.png", mediaType: "image/png" },
  {
    type: "file",
    url: "https://example.com/v1.webp",
    mediaType: "image/webp",
    [IMAGE_EDIT]: {
      schemaVersion: 1,
      lineageId: "https://example.com/origin.png",
      versionId: "iev_1",
      parentVersionId: null,
      operations: ["crop"],
      editedAt: 10,
    },
  },
]

function renderWithTarget(isStreaming = false) {
  workbenchProps = {}
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TooltipProvider>
        <MessageImageCollectionProvider
          target={{ sessionId: "s1", messageId: "m1", parts, isStreaming }}
        >
          <ImageBlock src="https://example.com/origin.png" alt="first" />
          <ImageBlock src="https://example.com/v1.webp" alt="second" />
        </MessageImageCollectionProvider>
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

/**
 * Every `ImageBlock` renders two controls named "View fullscreen": the picture
 * itself and its hover toolbar button. So block N's picture is at index N * 2.
 */
function openImage(blockIndex: number) {
  fireEvent.click(screen.getAllByRole("button", { name: "View fullscreen" })[blockIndex * 2])
}

function openFirstImage() {
  openImage(0)
}

describe("MessageImageCollectionProvider with a message target", () => {
  beforeEach(() => {
    liveQueryValue.current = null
  })

  it("opens the workbench rather than the read-only lightbox", () => {
    renderWithTarget()
    openFirstImage()
    expect(screen.getByTestId("mock-workbench")).toBeInTheDocument()
    expect(workbenchProps.open).toBe(true)
  })

  it("addresses the version at the message part's url, not the painted one", () => {
    renderWithTarget()
    openFirstImage()
    const source = workbenchProps.source as { lineageId: string; parentVersionId: string | null }
    expect(source.lineageId).toBe("https://example.com/origin.png")
    expect(source.parentVersionId).toBeNull()
  })

  it("parents a new edit on the version being edited", () => {
    renderWithTarget()
    openImage(1)
    const source = workbenchProps.source as { parentVersionId: string | null }
    expect(source.parentVersionId).toBe("iev_1")
  })

  it("builds the rail from the message's lineages", () => {
    renderWithTarget()
    openFirstImage()
    const rail = workbenchProps.rail as Array<{ url: string; depth: number }>
    expect(rail.map((row) => row.url)).toEqual([
      "https://example.com/origin.png",
      "https://example.com/v1.webp",
    ])
    expect(rail.map((row) => row.depth)).toEqual([0, 1])
  })

  it("allows saving on a settled, writable message", () => {
    renderWithTarget()
    openFirstImage()
    expect(workbenchProps.saveBlockedReason).toBeNull()
    expect(workbenchProps.target).toMatchObject({ canSave: true })
  })

  it("blocks saving while the turn is still streaming", () => {
    renderWithTarget(true)
    openFirstImage()
    expect(workbenchProps.saveBlockedReason).toBe("streaming")
    expect(workbenchProps.target).toMatchObject({ canSave: false })
  })

  it("blocks saving into a handoff-locked conversation", () => {
    // The database refuses the write anyway. Checking here is what stops the
    // button from looking live and spending a full re-encode before failing.
    liveQueryValue.current = { ticketId: "t-1" }
    renderWithTarget()
    openFirstImage()
    expect(workbenchProps.saveBlockedReason).toBe("read-only")
  })
})
