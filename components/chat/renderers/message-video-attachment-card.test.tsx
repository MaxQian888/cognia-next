import { render, screen, within } from "@testing-library/react"
import type { VideoAttachmentInfo } from "@/lib/chat/attachments/video/attachment-info"
import {
  collectMessageVideoAttachments,
  MessageVideoAttachmentCard,
} from "./message-video-attachment-card"

// The gallery has its own suite (lightbox, virtualisation, media refs); here it
// only has to receive the right items.
jest.mock("./message-image-gallery", () => ({
  MessageImageGallery: ({
    items,
    className,
  }: {
    items: Array<{ id: string; src: string; alt?: string }>
    className?: string
  }) => (
    <ul data-testid="gallery" data-class={className ?? ""}>
      {items.map((item) => (
        <li key={item.id} data-id={item.id} data-src={item.src}>
          {item.alt}
        </li>
      ))}
    </ul>
  ),
}))

function info(over: Partial<VideoAttachmentInfo> = {}): VideoAttachmentInfo {
  return {
    groupId: "g1",
    filename: "clip.mp4",
    sourceMediaType: "video/mp4",
    kind: "video",
    durationSec: 90,
    width: 1920,
    height: 1080,
    delivery: "storyboard",
    strategy: "uniform",
    range: null,
    frameTimes: [5, 15, 25, 35, 45, 55, 65, 75, 85],
    grid: { columns: 3, rows: 3 },
    engine: "browser",
    ...over,
  }
}

const text = (videoAttachment?: unknown) => ({
  type: "text",
  text: "Attached video…",
  ...(videoAttachment ? { videoAttachment } : {}),
})
const image = (url: string, videoAttachment?: unknown) => ({
  type: "file",
  url,
  mediaType: "image/jpeg",
  filename: "clip.mp4",
  ...(videoAttachment ? { videoAttachment } : {}),
})

describe("collectMessageVideoAttachments", () => {
  it("groups tagged parts by groupId at the first part's position", () => {
    const a = info()
    const b = info({ groupId: "g2", filename: "loop.gif", kind: "gif", delivery: "frames" })
    const parts = [
      { type: "text", text: "look at these" },
      text(a),
      image("data:a", a),
      text(b),
      image("data:b1", b),
      image("data:b2", b),
    ]
    const result = collectMessageVideoAttachments(parts)
    expect(result.attachments.map((x) => [x.info.groupId, x.firstPartIndex])).toEqual([
      ["g1", 1],
      ["g2", 3],
    ])
    expect([...result.partIndexes].sort()).toEqual([1, 2, 3, 4, 5])
    expect(result.byFirstPartIndex.get(3)?.images.map((i) => [i.partIndex, i.url])).toEqual([
      [4, "data:b1"],
      [5, "data:b2"],
    ])
    expect(result.byFirstPartIndex.has(2)).toBe(false)
  })

  it("leaves untagged and malformed parts alone", () => {
    const parts = [text(), image("data:x"), text({ groupId: "g1" }), image("data:y", { kind: "x" })]
    const result = collectMessageVideoAttachments(parts)
    expect(result.attachments).toEqual([])
    expect(result.partIndexes.size).toBe(0)
  })

  it("keeps a tagged part with no image (the description) in the group without an image", () => {
    const result = collectMessageVideoAttachments([
      text(info({ delivery: "native", frameTimes: [] })),
    ])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]!.images).toEqual([])
  })
})

describe("MessageVideoAttachmentCard", () => {
  const renderCard = (parts: unknown[]) => {
    const [attachment] = collectMessageVideoAttachments(parts).attachments
    return render(<MessageVideoAttachmentCard attachment={attachment!} idPrefix="m1" />)
  }

  it("summarises a storyboard and says the original is not kept", () => {
    const i = info()
    renderCard([text(i), image("data:board", i)])
    const card = screen.getByTestId("message-video-attachment")
    expect(within(card).getByTitle("clip.mp4")).toHaveTextContent("clip.mp4")
    expect(within(card).getByText("Video")).toBeInTheDocument()
    expect(
      within(card).getByText("1:30 · 1920×1080 · Storyboard of 9 frames evenly spaced")
    ).toBeInTheDocument()
    expect(within(card).getByText("The original file isn't saved.")).toBeInTheDocument()
    const items = within(screen.getByTestId("gallery")).getAllByRole("listitem")
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveAttribute("data-src", "data:board")
    expect(items[0]).toHaveAttribute("data-id", "m1-video-1")
    expect(items[0]).toHaveTextContent("clip.mp4")
  })

  it("labels separate frames with their times and shows a trimmed range", () => {
    const i = info({
      kind: "gif",
      filename: "loop.gif",
      durationSec: 4,
      delivery: "frames",
      strategy: "scene",
      range: { startSec: 1, endSec: 3.5 },
      frameTimes: [1.2, 2.8],
    })
    renderCard([text(i), image("data:f1", i), image("data:f2", i)])
    expect(screen.getByText("GIF")).toBeInTheDocument()
    expect(
      screen.getByText("0:04.0 · 1920×1080 · 2 frames at scene changes · 0:01.0–0:03.5")
    ).toBeInTheDocument()
    const items = within(screen.getByTestId("gallery")).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "loop.gif · 0:01.2",
      "loop.gif · 0:02.8",
    ])
    // Two frames keep the gallery's own layout.
    expect(screen.getByTestId("gallery")).toHaveAttribute("data-class", "")
  })

  it("lays three or more frames out as a compact contact sheet", () => {
    const i = info({ delivery: "frames", frameTimes: [1, 2, 3] })
    renderCard([text(i), image("data:1", i), image("data:2", i), image("data:3", i)])
    expect(screen.getByTestId("gallery")).toHaveAttribute("data-class", "grid-cols-3 gap-1")
  })

  it("shows the poster of an original video", () => {
    const i = info({ delivery: "native", frameTimes: [] })
    renderCard([text(i), image("data:poster", i)])
    expect(screen.getByText("1:30 · 1920×1080 · Sent as the original video")).toBeInTheDocument()
    expect(within(screen.getByTestId("gallery")).getByRole("listitem")).toHaveAttribute(
      "data-src",
      "data:poster"
    )
  })

  it("renders no gallery when no image survived", () => {
    renderCard([text(info({ delivery: "native", frameTimes: [] }))])
    expect(screen.queryByTestId("gallery")).not.toBeInTheDocument()
    expect(screen.getByText("The original file isn't saved.")).toBeInTheDocument()
  })
})
