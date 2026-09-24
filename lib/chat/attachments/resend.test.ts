import type { AttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { VIDEO_ATTACHMENT_PART_KEY } from "./video/attachment-info"
import type { VideoAttachmentInfo } from "./video/attachment-info"

jest.mock("@/lib/chat/media/normalize-message-media", () => ({
  materializeMessageMedia: jest.fn(),
}))

import { materializeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { resendableAttachments, resendableUserTurn } from "./resend"

const materializeMock = materializeMessageMedia as jest.Mock

const PNG = "data:image/png;base64,iVBORw0KGgo="
const extraction: AttachmentExtractedContent = {
  attachmentId: "asset-1",
  contentHash: "a".repeat(64),
  status: "ready",
  segments: [{ id: "s1", text: "Q3 revenue", locator: { type: "page", page: 1 } }],
  processor: { id: "pdf", version: "1" },
}
const docPart = {
  type: "file",
  filename: "report.pdf",
  mediaType: "application/pdf",
  text: "Q3 revenue grew 12%.",
  extractedContent: extraction,
}
function video(delivery: VideoAttachmentInfo["delivery"]): VideoAttachmentInfo {
  return {
    groupId: `g-${delivery}`,
    filename: `${delivery}.mp4`,
    sourceMediaType: "video/mp4",
    kind: "video",
    durationSec: 4,
    width: 640,
    height: 360,
    delivery,
    strategy: "uniform",
    range: null,
    frameTimes: delivery === "native" ? [] : [0, 2],
    engine: "browser",
  }
}

beforeEach(() => {
  materializeMock.mockReset()
})

describe("resendableAttachments", () => {
  it("rebuilds an extracted document as the text block it sent, with its provenance", async () => {
    const result = await resendableAttachments([docPart, { type: "text", text: "summarize" }])
    expect(result.blocks).toEqual([{ type: "text", text: "Q3 revenue grew 12%." }])
    expect(result.manifest).toEqual([
      {
        filename: "report.pdf",
        mediaType: "application/pdf",
        kind: "document",
        extractedContent: extraction,
      },
    ])
    expect(result.unavailable).toEqual([])
  })

  it("keeps an audio transcript an audio attachment", async () => {
    const result = await resendableAttachments([
      { type: "file", filename: "call.m4a", mediaType: "audio/mp4", text: "hello there" },
    ])
    expect(result.manifest[0]).toEqual(expect.objectContaining({ kind: "audio" }))
  })

  it("rebuilds an image and puts its OCR text under the same entry", async () => {
    const result = await resendableAttachments([
      { type: "file", filename: "shot.png", mediaType: "image/png", url: PNG },
      { type: "file", filename: "shot.png", mediaType: "image/png", text: "OCR words" },
    ])
    expect(result.blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "OCR words" },
    ])
    expect(result.manifest).toHaveLength(2)
    expect(result.manifest[0]).toBe(result.manifest[1])
    expect(result.manifest[0]).toEqual({
      filename: "shot.png",
      mediaType: "image/png",
      kind: "image",
    })
  })

  it("reads a stored image's canonical bytes back from its media reference", async () => {
    materializeMock.mockImplementation(async (message: { parts: unknown[] }) => ({
      ...message,
      parts: [{ type: "file", url: PNG, mediaType: "image/png" }],
    }))
    const result = await resendableAttachments([
      { type: "file", filename: "shot.png", mediaType: "image/png", url: "cognia-media:abc" },
    ])
    expect(materializeMock).toHaveBeenCalledWith(
      expect.objectContaining({ parts: [{ type: "file", url: "cognia-media:abc" }] })
    )
    expect(result.blocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ])
  })

  it("leaves out an image whose bytes are gone, and names it, instead of failing the turn", async () => {
    materializeMock.mockRejectedValue(new Error("handoff_attachment_unavailable"))
    const result = await resendableAttachments([
      { type: "file", filename: "gone.png", mediaType: "image/png", url: "cognia-media:abc" },
      { type: "file", filename: "gone.png", mediaType: "image/png", text: "its OCR" },
      docPart,
    ])
    // The image goes with its OCR: half an attachment is not what was sent.
    expect(result.blocks).toEqual([{ type: "text", text: "Q3 revenue grew 12%." }])
    expect(result.manifest.map((entry) => entry.filename)).toEqual(["report.pdf"])
    expect(result.unavailable).toEqual(["gone.png"])
  })

  it("leaves out a file that is neither an image nor text", async () => {
    const result = await resendableAttachments([
      { type: "file", filename: "remote.pdf", mediaType: "application/pdf", url: "https://x/y" },
      { type: "file", filename: "empty.bin", mediaType: "application/octet-stream" },
    ])
    expect(result.blocks).toEqual([])
    expect(result.unavailable).toEqual(["remote.pdf", "empty.bin"])
  })

  it("rebuilds a sampled video as its description and frames under one video entry", async () => {
    const info = video("frames")
    const tag = { [VIDEO_ATTACHMENT_PART_KEY]: info }
    const result = await resendableAttachments([
      {
        type: "file",
        mediaType: "text/plain",
        text: "A cat jumps.",
        ...tag,
        extractedContent: extraction,
      },
      { type: "file", mediaType: "image/png", url: PNG, ...tag },
      { type: "file", mediaType: "image/png", url: PNG, ...tag },
    ])
    expect(result.blocks.map((block) => block.type)).toEqual(["text", "image", "image"])
    expect(new Set(result.manifest).size).toBe(1)
    expect(result.manifest[0]).toEqual({
      filename: "frames.mp4",
      mediaType: "video/mp4",
      kind: "video",
      video: { info },
      extractedContent: extraction,
    })
  })

  it("leaves out a natively sent video, whose file the row never kept", async () => {
    const tag = { [VIDEO_ATTACHMENT_PART_KEY]: video("native") }
    const result = await resendableAttachments([
      { type: "file", mediaType: "text/plain", text: "A cat jumps.", ...tag },
      { type: "file", mediaType: "image/png", url: PNG, ...tag },
      docPart,
    ])
    expect(result.manifest.map((entry) => entry.filename)).toEqual(["report.pdf"])
    expect(result.unavailable).toEqual(["native.mp4"])
  })
})

describe("resendableUserTurn", () => {
  it("lays the turn out as it was sent: attachments, the typed text, then link context", async () => {
    const turn = await resendableUserTurn([
      docPart,
      { type: "text", text: "@codex what drove it?" },
      { type: "text", text: "[Link] https://example.com: page text" },
    ])
    expect(turn.content).toEqual([
      { type: "text", text: "Q3 revenue grew 12%." },
      { type: "text", text: "@codex what drove it?" },
      { type: "text", text: "[Link] https://example.com: page text" },
    ])
    expect(turn.manifest).toHaveLength(1)
  })

  it("is the plain string a text-only turn was sent as", async () => {
    expect(await resendableUserTurn([{ type: "text", text: "hello" }])).toEqual({
      content: "hello",
      manifest: [],
      unavailable: [],
    })
  })

  it("does not read a video's description as the typed text", async () => {
    const tag = { [VIDEO_ATTACHMENT_PART_KEY]: video("frames") }
    const turn = await resendableUserTurn([
      { type: "text", text: "A cat jumps.", ...tag },
      { type: "file", mediaType: "image/png", url: PNG, ...tag },
      { type: "text", text: "what happens?" },
    ])
    expect(turn.content).toEqual([
      { type: "text", text: "A cat jumps." },
      expect.objectContaining({ type: "image" }),
      { type: "text", text: "what happens?" },
    ])
    expect(turn.manifest).toHaveLength(2)
  })
})
