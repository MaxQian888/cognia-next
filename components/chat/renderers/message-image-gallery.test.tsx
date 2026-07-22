/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { MessageImageGallery } from "./message-image-gallery"

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
  ImageLightbox: ({ open, activeIndex }: { open: boolean; activeIndex: number }) => (
    <output data-testid="lightbox-state">{open ? `open:${activeIndex}` : "closed"}</output>
  ),
}))

const items = [
  { id: "one", src: "data:image/png;base64,one", alt: "one.png", filename: "one.png" },
  { id: "two", src: "data:image/png;base64,two", alt: "two.png", filename: "two.png" },
]

describe("MessageImageGallery", () => {
  beforeEach(() => mockUseReducedMotion.mockReturnValue(false))

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
})
