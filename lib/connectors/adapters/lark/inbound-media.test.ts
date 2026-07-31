import { enrichLarkInboundMedia } from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

// The default (non-injected) document-text extractor dynamically imports this.
jest.mock("@cognia/document/document-processor", () => ({
  processDocumentAsync: jest.fn(async () => ({ content: "extracted pdf text" })),
}))
import { processDocumentAsync } from "@cognia/document/document-processor"
const mockProcessDoc = processDocumentAsync as jest.Mock

function makeEvent(segments: MessageSegment[], messageId = "om_msg_1"): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "lark-1",
    selfId: "ou_bot",
    messageId,
    conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "oc_chat" },
    conversationKey: "lark:lark-1:oc_chat",
    sender: { id: "lark:ou_u", platform: "lark", adapterId: "lark-1", remoteUserId: "ou_u" },
    channel: { id: "lark:lark-1:oc_chat", kind: "group", platformChannelId: "oc_chat" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 0,
    raw: {},
  }
}

function baseDeps() {
  const fetchAttachment = jest.fn(async (adapterId: string, remoteRef: string) => ({
    localUrl: `/cache/${remoteRef}`,
    remoteRef,
  }))
  const readAttachment = jest.fn(async () => "QUJD") // base64("ABC")
  return {
    getAccessToken: jest.fn(async () => "tat_123"),
    fetchAttachment: fetchAttachment as never,
    readAttachment: readAttachment as never,
    enabled: true,
  }
}

describe("enrichLarkInboundMedia — images", () => {
  it("downloads image bytes and attaches dataBase64 + default mimeType", async () => {
    const seg = { type: "image" as const, url: "img_key_1", alt: "image" }
    const event = makeEvent([seg])
    const deps = baseDeps()

    await enrichLarkInboundMedia(event, deps)

    expect(deps.getAccessToken).toHaveBeenCalledTimes(1)
    expect(deps.fetchAttachment).toHaveBeenCalledWith(
      "lark-1",
      "lark:om_msg_1:img_key_1",
      "https://open.feishu.cn/open-apis/im/v1/messages/om_msg_1/resources/img_key_1?type=image",
      { Authorization: "Bearer tat_123" }
    )
    const img = event.segments[0] as MessageSegment & { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("QUJD")
    expect(img.mimeType).toBe("image/png")
  })

  it("skips an image that already carries inline bytes", async () => {
    const seg = {
      type: "image" as const,
      url: "img_key_1",
      dataBase64: "existing",
    } as MessageSegment
    const event = makeEvent([seg])
    const deps = baseDeps()

    await enrichLarkInboundMedia(event, deps)

    expect(deps.fetchAttachment).not.toHaveBeenCalled()
  })

  it("leaves the segment untouched when read returns null (over cap)", async () => {
    const seg = { type: "image" as const, url: "img_key_1", alt: "image" }
    const event = makeEvent([seg])
    const deps = baseDeps()
    ;(deps.readAttachment as jest.Mock).mockResolvedValue(null)

    await enrichLarkInboundMedia(event, deps)

    const img = event.segments[0] as MessageSegment & { dataBase64?: string }
    expect(img.dataBase64).toBeUndefined()
  })

  it("keeps an explicit image mimeType instead of defaulting to png", async () => {
    const seg = {
      type: "image" as const,
      url: "img_key_1",
      alt: "image",
      mimeType: "image/jpeg",
    } as MessageSegment
    const event = makeEvent([seg])
    const deps = baseDeps()

    await enrichLarkInboundMedia(event, deps)

    const img = event.segments[0] as MessageSegment & { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("QUJD")
    expect(img.mimeType).toBe("image/jpeg")
  })
})

describe("enrichLarkInboundMedia — files", () => {
  it("downloads a document file and attaches extracted text as ocrText", async () => {
    const seg = {
      type: "file" as const,
      url: "file_key_1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    const deps = baseDeps()
    const extractDocText = jest.fn(async () => "extracted document text")

    await enrichLarkInboundMedia(event, { ...deps, extractDocText })

    expect(deps.fetchAttachment).toHaveBeenCalledWith(
      "lark-1",
      "lark:om_msg_1:file_key_1",
      "https://open.feishu.cn/open-apis/im/v1/messages/om_msg_1/resources/file_key_1?type=file",
      { Authorization: "Bearer tat_123" }
    )
    expect(extractDocText).toHaveBeenCalled()
    const file = event.segments[0] as Extract<MessageSegment, { type: "file" }>
    expect(file.ocrText).toBe("extracted document text")
  })

  it("downloads a non-document file but does not attempt text extraction", async () => {
    const seg = {
      type: "file" as const,
      url: "file_key_z",
      name: "archive.zip",
      mimeType: "application/zip",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    const deps = baseDeps()
    const extractDocText = jest.fn(async () => "should not run")

    await enrichLarkInboundMedia(event, { ...deps, extractDocText })

    expect(deps.fetchAttachment).toHaveBeenCalledTimes(1) // still cached
    expect(extractDocText).not.toHaveBeenCalled()
    const file = event.segments[0] as Extract<MessageSegment, { type: "file" }>
    expect(file.ocrText).toBeUndefined()
  })

  it("uses processDocumentAsync as the default doc-text extractor", async () => {
    const seg = {
      type: "file" as const,
      url: "file_key_d",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    // No extractDocText injected → exercises the default (dynamic-import) path.
    await enrichLarkInboundMedia(event, baseDeps())
    const file = event.segments[0] as Extract<MessageSegment, { type: "file" }>
    expect(file.ocrText).toBe("extracted pdf text")
  })

  it("does not re-extract a file that already carries ocrText", async () => {
    const seg = {
      type: "file" as const,
      url: "file_key_o",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
      ocrText: "already extracted",
    } as MessageSegment
    const event = makeEvent([seg])
    const deps = baseDeps()
    const extractDocText = jest.fn(async () => "fresh")

    await enrichLarkInboundMedia(event, { ...deps, extractDocText })

    expect(deps.fetchAttachment).toHaveBeenCalledTimes(1) // still downloads to cache
    expect(extractDocText).not.toHaveBeenCalled()
    expect((event.segments[0] as Extract<MessageSegment, { type: "file" }>).ocrText).toBe(
      "already extracted"
    )
  })

  it("skips extraction when the file bytes cannot be read (over cap)", async () => {
    const seg = {
      type: "file" as const,
      url: "file_key_n",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    const deps = baseDeps()
    ;(deps.readAttachment as jest.Mock).mockResolvedValue(null)
    const extractDocText = jest.fn(async () => "x")

    await enrichLarkInboundMedia(event, { ...deps, extractDocText })

    expect(extractDocText).not.toHaveBeenCalled()
    expect((event.segments[0] as Extract<MessageSegment, { type: "file" }>).ocrText).toBeUndefined()
  })
})

describe("enrichLarkInboundMedia — guards & best-effort", () => {
  it("is a no-op when disabled (web mode / not Tauri)", async () => {
    const event = makeEvent([{ type: "image", url: "k", alt: "image" }])
    const deps = { ...baseDeps(), enabled: false }
    await enrichLarkInboundMedia(event, deps)
    expect(deps.getAccessToken).not.toHaveBeenCalled()
    expect(deps.fetchAttachment).not.toHaveBeenCalled()
  })

  it("is a no-op when the event has no messageId", async () => {
    const event = makeEvent([{ type: "image", url: "k", alt: "image" }], "")
    const deps = baseDeps()
    await enrichLarkInboundMedia(event, deps)
    expect(deps.fetchAttachment).not.toHaveBeenCalled()
  })

  it("leaves segments intact when the token cannot be resolved", async () => {
    const seg = { type: "image" as const, url: "k", alt: "image" }
    const event = makeEvent([seg])
    const deps = baseDeps()
    ;(deps.getAccessToken as jest.Mock).mockRejectedValue(new Error("keyring locked"))

    await enrichLarkInboundMedia(event, deps)

    expect(deps.fetchAttachment).not.toHaveBeenCalled()
    expect((event.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("never throws when a download fails — the segment keeps its marker", async () => {
    const seg = { type: "image" as const, url: "k", alt: "image" }
    const event = makeEvent([seg])
    const deps = baseDeps()
    ;(deps.fetchAttachment as jest.Mock).mockRejectedValue(new Error("403 token expired"))

    await expect(enrichLarkInboundMedia(event, deps)).resolves.toBeUndefined()
    expect((event.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("resolves the token once for a multi-image post", async () => {
    const event = makeEvent([
      { type: "image", url: "k1", alt: "image" },
      { type: "image", url: "k2", alt: "image" },
    ])
    const deps = baseDeps()

    await enrichLarkInboundMedia(event, deps)

    expect(deps.getAccessToken).toHaveBeenCalledTimes(1)
    expect(deps.fetchAttachment).toHaveBeenCalledTimes(2)
  })

  it("defaults to isTauri() (disabled here) when `enabled` is omitted", async () => {
    const event = makeEvent([{ type: "image", url: "k", alt: "image" }])
    const { enabled: _drop, ...deps } = baseDeps()
    void _drop
    await enrichLarkInboundMedia(event, deps)
    // jsdom is not a Tauri host → isTauri() is false → no-op.
    expect(deps.getAccessToken).not.toHaveBeenCalled()
  })

  it("skips an image segment with an empty media key", async () => {
    const event = makeEvent([{ type: "image", url: "", alt: "image" }])
    const deps = baseDeps()
    await enrichLarkInboundMedia(event, deps)
    expect(deps.fetchAttachment).not.toHaveBeenCalled()
  })

  it("does not extract text from an extension-less file", async () => {
    const seg = {
      type: "file" as const,
      url: "fk",
      name: "README",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    const deps = baseDeps()
    const extractDocText = jest.fn(async () => "x")
    await enrichLarkInboundMedia(event, { ...deps, extractDocText })
    expect(deps.fetchAttachment).toHaveBeenCalledTimes(1) // still downloads
    expect(extractDocText).not.toHaveBeenCalled()
  })

  it("skips a file segment with an empty media key", async () => {
    const event = makeEvent([
      { type: "file", url: "", name: "x.pdf", mimeType: "application/pdf", sizeBytes: 0 },
    ])
    const deps = baseDeps()
    await enrichLarkInboundMedia(event, deps)
    expect(deps.fetchAttachment).not.toHaveBeenCalled()
  })

  it("leaves ocrText unset when the default extractor yields no content", async () => {
    mockProcessDoc.mockResolvedValueOnce({}) // no `content` field → `?? ""`
    const seg = {
      type: "file" as const,
      url: "fk",
      name: "empty.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    await enrichLarkInboundMedia(event, baseDeps())
    expect((event.segments[0] as Extract<MessageSegment, { type: "file" }>).ocrText).toBeUndefined()
  })

  it("swallows a doc-extractor rejection (segment keeps just its name marker)", async () => {
    const seg = {
      type: "file" as const,
      url: "fk",
      name: "boom.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    }
    const event = makeEvent([seg])
    const deps = baseDeps()
    const extractDocText = jest.fn(async () => {
      throw new Error("parser blew up")
    })
    await expect(
      enrichLarkInboundMedia(event, { ...deps, extractDocText })
    ).resolves.toBeUndefined()
    expect((event.segments[0] as Extract<MessageSegment, { type: "file" }>).ocrText).toBeUndefined()
  })
})
