/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { MessageImageGallery } from "./message-image-gallery"
import { getMessageMedia, mediaRef } from "@/lib/db/message-media"
import { __TESTING__ as resolveTesting } from "@/lib/chat/media/resolve-media"

jest.mock("@/lib/db/message-media", () => {
  const actual = jest.requireActual("@/lib/db/message-media")
  return { ...actual, getMessageMedia: jest.fn() }
})

const mockGetMessageMedia = jest.mocked(getMessageMedia)

const mockUseReducedMotion = jest.fn(() => false)

jest.mock("motion/react", () => ({
  ...jest.requireActual("../../../__mocks__/motion-react.js"),
  useReducedMotion: () => mockUseReducedMotion(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values?.name ? `${key}:${values.name}` : key,
}))

jest.mock("./image-lightbox", () => ({
  ImageLightbox: ({
    open,
    activeIndex,
    items,
  }: {
    open: boolean
    activeIndex: number
    items: Array<{ src: string }>
  }) => (
    <output data-testid="lightbox-state" data-src={items[activeIndex]?.src}>
      {open ? `open:${activeIndex}` : "closed"}
    </output>
  ),
}))

const items = [
  { id: "one", src: "data:image/png;base64,one", alt: "one.png", filename: "one.png" },
  { id: "two", src: "data:image/png;base64,two", alt: "two.png", filename: "two.png" },
]

describe("MessageImageGallery", () => {
  beforeEach(() => {
    mockUseReducedMotion.mockReturnValue(false)
    mockGetMessageMedia.mockReset()
    resolveTesting.reset()
    URL.createObjectURL = jest.fn(() => "blob:resolved-gallery")
    URL.revokeObjectURL = jest.fn()
  })

  it("renders image thumbnails and opens the selected image", () => {
    render(<MessageImageGallery items={items} />)

    expect(screen.getAllByTestId("message-image-thumbnail")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "previewAria:two.png" }))
    expect(screen.getByTestId("lightbox-state")).toHaveTextContent("open:1")
  })

  it("renders nothing when the gallery is empty", () => {
    const { container } = render(<MessageImageGallery items={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it("renders a single image with title fallback and reduced motion", () => {
    mockUseReducedMotion.mockReturnValue(true)
    render(
      <MessageImageGallery
        items={[{ id: "single", src: "data:image/png;base64,single", title: "Cover" }]}
        className="custom-gallery"
      />
    )

    const thumbnail = screen.getByRole("button", { name: "previewAria:Cover" })
    expect(thumbnail).toHaveClass("max-h-72")
    expect(screen.getByRole("group")).toHaveClass("custom-gallery")
    fireEvent.click(thumbnail)
    expect(screen.getByTestId("lightbox-state")).toHaveTextContent("open:0")
  })

  it("falls back to alt text and then the default title", () => {
    const { rerender } = render(
      <MessageImageGallery
        items={[{ id: "alt", src: "data:image/png;base64,alt", alt: "Alt label" }]}
      />
    )
    expect(screen.getByRole("button", { name: "previewAria:Alt label" })).toBeInTheDocument()

    rerender(
      <MessageImageGallery items={[{ id: "default", src: "data:image/png;base64,default" }]} />
    )
    expect(screen.getByRole("button", { name: "previewAria:defaultTitle" })).toBeInTheDocument()
  })

  it("mounts at most twelve initial tiles and opens a virtualized full grid", () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      id: `image-${index}`,
      src: `data:image/png;base64,${index}`,
      alt: `image ${index}`,
    }))

    render(<MessageImageGallery items={many} />)

    expect(screen.getAllByTestId("message-image-thumbnail")).toHaveLength(12)
    fireEvent.click(screen.getByRole("button", { name: "showAllImages" }))
    expect(screen.getByText("allImagesTitle")).toBeInTheDocument()
    expect(screen.getAllByTestId("message-image-thumbnail").length).toBeLessThan(27)
  })

  it("resolves a content-addressed file before assigning the img src", async () => {
    mockGetMessageMedia.mockResolvedValue({
      hash: "h",
      mediaType: "image/png",
      width: 10,
      height: 10,
      blob: { size: 3 } as Blob,
      byteSize: 3,
      createdAt: 1,
      lastUsedAt: 1,
    })

    render(
      <MessageImageGallery items={[{ id: "stored", src: mediaRef("h"), alt: "stored image" }]} />
    )

    await waitFor(() => {
      expect(screen.getByAltText("stored image")).toHaveAttribute("src", "blob:resolved-gallery")
    })
    expect(screen.getByAltText("stored image")).not.toHaveAttribute("src", mediaRef("h"))
  })

  it("loads the canonical variant only after a thumbnail is opened", async () => {
    mockGetMessageMedia.mockResolvedValue({
      hash: "h",
      mediaType: "image/png",
      width: 100,
      height: 100,
      blob: { size: 30 } as Blob,
      thumbBlob: { size: 3 } as Blob,
      thumbWidth: 10,
      thumbHeight: 10,
      byteSize: 30,
      createdAt: 1,
      lastUsedAt: 1,
    })
    URL.createObjectURL = jest
      .fn()
      .mockReturnValueOnce("blob:thumbnail")
      .mockReturnValueOnce("blob:canonical")

    render(<MessageImageGallery items={[{ id: "stored", src: mediaRef("h"), alt: "stored" }]} />)
    await waitFor(() =>
      expect(screen.getByAltText("stored")).toHaveAttribute("src", "blob:thumbnail")
    )
    expect(mockGetMessageMedia).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "previewAria:stored" }))

    await waitFor(() => {
      expect(screen.getByTestId("lightbox-state")).toHaveTextContent("open:0")
      expect(screen.getByTestId("lightbox-state")).toHaveAttribute("data-src", "blob:canonical")
    })
    expect(mockGetMessageMedia).toHaveBeenCalledTimes(2)
  })
})
