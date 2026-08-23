import {
  enrichInboundMedia,
  isExtractableDoc,
  isPublicHttpUrl,
  onceAsync,
  sniffImageMediaType,
  stableMediaRef,
  __resetInboundMediaOverCapMemo,
  type EnrichableSegment,
  type InboundMediaPlan,
} from "./inbound-media"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

// The default (non-injected) document-text extractor dynamically imports this.
jest.mock("@cognia/document/document-processor", () => ({
  processDocumentAsync: jest.fn(async () => ({ content: "extracted pdf text" })),
}))
import { processDocumentAsync } from "@cognia/document/document-processor"
const mockProcessDoc = processDocumentAsync as jest.Mock

function makeEvent(segments: MessageSegment[]): NormalizedInboundEvent {
  return {
    platform: "discord",
    adapterId: "ad-1",
    selfId: "bot",
    messageId: "m1",
    conversationRef: { platform: "discord", adapterId: "ad-1" },
    conversationKey: "discord:ad-1:c1",
    sender: { id: "u1", platform: "discord", adapterId: "ad-1", remoteUserId: "1" },
    channel: { id: "c1", kind: "group" },
    segments,
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }
}

const image = (url = "https://cdn.example.com/a.png"): MessageSegment => ({ type: "image", url })

const file = (name: string, url = "https://cdn.example.com/f"): MessageSegment => ({
  type: "file",
  url,
  name,
  mimeType: "application/pdf",
  sizeBytes: 10,
})

function harness(plan: Partial<InboundMediaPlan> = {}) {
  const fetchAttachment = jest.fn().mockResolvedValue({ cacheKey: "k", remoteRef: "r" })
  const readAttachment = jest.fn().mockResolvedValue(null)
  const source = jest.fn(async () => ({ url: "https://dl.example.com/bytes" }))
  const full: InboundMediaPlan = {
    ref: (seg: EnrichableSegment) => (seg.url ? stableMediaRef("test", seg.url) : undefined),
    source,
    extractLabel: "test-inbound",
    ...plan,
  }
  return {
    plan: full,
    source,
    deps: {
      fetchAttachment: fetchAttachment as never,
      readAttachment: readAttachment as never,
      enabled: true,
    },
    fetchAttachment,
    readAttachment,
  }
}

describe("stableMediaRef", () => {
  it("drops the signature Discord refreshes on every redelivery", () => {
    const a = stableMediaRef(
      "discord",
      "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&hm=x"
    )
    const b = stableMediaRef(
      "discord",
      "https://cdn.discordapp.com/attachments/1/2/a.png?ex=9&hm=y"
    )
    expect(a).toBe(b)
    expect(a).toBe("discord:/attachments/1/2/a.png")
  })

  it("keeps two different files apart", () => {
    expect(stableMediaRef("d", "https://x/1/a.png")).not.toBe(
      stableMediaRef("d", "https://x/2/a.png")
    )
  })

  it("falls back to the raw value when it is not a URL", () => {
    expect(stableMediaRef("lark", "img_key_1")).toBe("lark:img_key_1")
  })
})

describe("onceAsync", () => {
  it("resolves the underlying call exactly once", async () => {
    const fn = jest.fn(async () => "tok")
    const once = onceAsync(fn)
    expect(await Promise.all([once(), once(), once()])).toEqual(["tok", "tok", "tok"])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("memoises the failure too — a locked keyring is read once, not per segment", async () => {
    const fn = jest.fn(async () => {
      throw new Error("locked")
    })
    const once = onceAsync(fn)
    await expect(once()).rejects.toThrow("locked")
    await expect(once()).rejects.toThrow("locked")
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("isExtractableDoc", () => {
  it("accepts document types regardless of case", () => {
    expect(isExtractableDoc("report.PDF")).toBe(true)
    expect(isExtractableDoc("a.docx")).toBe(true)
  })

  it("rejects media and extension-less names", () => {
    expect(isExtractableDoc("clip.mp4")).toBe(false)
    expect(isExtractableDoc("README")).toBe(false)
  })
})

describe("enrichInboundMedia", () => {
  it("downloads an image and inlines the bytes", async () => {
    const h = harness()
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValueOnce("QUJD")
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    const img = e.segments[0] as { dataBase64?: string; mimeType?: string }
    expect(img.dataBase64).toBe("QUJD")
    expect(h.fetchAttachment).toHaveBeenCalledWith(
      "ad-1",
      "test:/a.png",
      "https://dl.example.com/bytes",
      undefined
    )
  })

  it("reads the cache before resolving anything — a hit costs no download", async () => {
    const h = harness()
    h.readAttachment.mockResolvedValue("CACHED")
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(h.source).not.toHaveBeenCalled()
    expect(h.fetchAttachment).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBe("CACHED")
  })

  it("makes no call at all for a text-only message", async () => {
    const h = harness()
    await enrichInboundMedia(makeEvent([{ type: "text", text: "hi" }]), h.plan, h.deps)
    expect(h.readAttachment).not.toHaveBeenCalled()
    expect(h.source).not.toHaveBeenCalled()
  })

  it("skips a segment the plan cannot name", async () => {
    const h = harness({ ref: () => undefined })
    await enrichInboundMedia(makeEvent([image()]), h.plan, h.deps)
    expect(h.readAttachment).not.toHaveBeenCalled()
  })

  it("passes the auth header the download needs", async () => {
    const h = harness({
      source: async () => ({
        url: "https://files.example.com/p",
        headers: { Authorization: "Bearer t" },
      }),
    })
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValueOnce("QUJD")

    await enrichInboundMedia(makeEvent([image()]), h.plan, h.deps)

    expect(h.fetchAttachment).toHaveBeenCalledWith(
      "ad-1",
      "test:/a.png",
      "https://files.example.com/p",
      {
        Authorization: "Bearer t",
      }
    )
  })
})

describe("isPublicHttpUrl", () => {
  it("accepts ordinary public http(s) media hosts", () => {
    expect(isPublicHttpUrl("https://cdn.example.com/a.png")).toBe(true)
    expect(isPublicHttpUrl("http://gchat.qpic.cn/a.jpg")).toBe(true)
    expect(isPublicHttpUrl("https://8.8.8.8/a.png")).toBe(true)
  })

  it("refuses loopback, LAN and the cloud metadata endpoint", () => {
    // The download URL is remote-controlled data and Rust applies no guard of
    // its own, so this is the only thing standing between an inbound message
    // and a request to the host's own network.
    expect(isPublicHttpUrl("http://127.0.0.1:8080/admin")).toBe(false)
    expect(isPublicHttpUrl("http://localhost/x")).toBe(false)
    expect(isPublicHttpUrl("http://router.local/x")).toBe(false)
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false)
    expect(isPublicHttpUrl("http://192.168.1.1/x")).toBe(false)
    expect(isPublicHttpUrl("http://10.0.0.5/x")).toBe(false)
    expect(isPublicHttpUrl("http://172.16.0.1/x")).toBe(false)
    expect(isPublicHttpUrl("http://172.31.255.1/x")).toBe(false)
    expect(isPublicHttpUrl("http://[::1]/x")).toBe(false)
    expect(isPublicHttpUrl("http://[fd00::1]/x")).toBe(false)
  })

  it("refuses the IPv6 spellings of the same private addresses", () => {
    // The URL parser re-serialises `::ffff:127.0.0.1` as `::ffff:7f00:1`, so a
    // prefix match on the text sees nothing. Decoding the embedded v4 address
    // is the only thing that closes it.
    expect(isPublicHttpUrl("http://[::ffff:127.0.0.1]/x")).toBe(false)
    expect(isPublicHttpUrl("http://[::ffff:169.254.169.254]/latest/meta-data/")).toBe(false)
    expect(isPublicHttpUrl("http://[::ffff:192.168.1.1]/x")).toBe(false)
    // `::` is the unspecified address, which most stacks route to loopback.
    expect(isPublicHttpUrl("http://[::]/x")).toBe(false)
    expect(isPublicHttpUrl("http://[0:0:0:0:0:0:0:1]/x")).toBe(false)
    expect(isPublicHttpUrl("http://[fe80::1]/x")).toBe(false)
    // Site-local, which the old prefix list did not mention at all.
    expect(isPublicHttpUrl("http://[fec0::1]/x")).toBe(false)
    expect(isPublicHttpUrl("http://[fc00::1]/x")).toBe(false)
    // An address we cannot decode is not one we can clear.
    expect(isPublicHttpUrl("http://[::ffff:999.0.0.1]/x")).toBe(false)
  })

  it("keeps public addresses next to the private ranges", () => {
    expect(isPublicHttpUrl("http://172.32.0.1/x")).toBe(true)
    expect(isPublicHttpUrl("http://172.15.0.1/x")).toBe(true)
    expect(isPublicHttpUrl("http://[2606:4700::1]/x")).toBe(true)
    expect(isPublicHttpUrl("http://[2001:db8::1]/x")).toBe(true)
    expect(isPublicHttpUrl("http://[::ffff:1.2.3.4]/x")).toBe(true)
  })

  it("refuses anything that is not http(s)", () => {
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false)
    expect(isPublicHttpUrl("tg://file/ABC")).toBe(false)
    expect(isPublicHttpUrl("not a url")).toBe(false)
  })
})

describe("enrichInboundMedia — download floor", () => {
  it("refuses a plan that resolves to a host on the operator's own network", async () => {
    const h = harness({ source: async () => ({ url: "http://127.0.0.1:9200/x.png" }) })
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(h.fetchAttachment).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })
})

describe("enrichInboundMedia — image media type", () => {
  it("prefers the type the parser already knew", async () => {
    const h = harness({
      source: async () => ({ url: "https://dl.example.com/x", mimeType: "image/gif" }),
    })
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValueOnce("QUJD")
    const seg = { type: "image" as const, url: "https://x/a.png", mimeType: "image/webp" }

    await enrichInboundMedia(makeEvent([seg as MessageSegment]), h.plan, h.deps)

    expect((seg as { mimeType?: string }).mimeType).toBe("image/webp")
  })

  it("takes what the resolver learned over the plan default", async () => {
    const h = harness({
      source: async () => ({ url: "https://dl.example.com/x", mimeType: "image/gif" }),
      defaultImageMime: "image/jpeg",
    })
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValueOnce("QUJD")
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect((e.segments[0] as { mimeType?: string }).mimeType).toBe("image/gif")
  })

  it("falls back to the plan default, then to png", async () => {
    const h = harness({ defaultImageMime: "image/jpeg" })
    h.readAttachment.mockResolvedValue("QUJD")
    const withDefault = makeEvent([image()])
    await enrichInboundMedia(withDefault, h.plan, h.deps)
    expect((withDefault.segments[0] as { mimeType?: string }).mimeType).toBe("image/jpeg")

    const bare = harness()
    bare.readAttachment.mockResolvedValue("QUJD")
    const noDefault = makeEvent([image()])
    await enrichInboundMedia(noDefault, bare.plan, bare.deps)
    expect((noDefault.segments[0] as { mimeType?: string }).mimeType).toBe("image/png")
  })
})

describe("enrichInboundMedia — documents", () => {
  it("extracts text so the model reads the contents, not the file name", async () => {
    const extractDocText = jest.fn().mockResolvedValue("  the report says yes  ")
    const h = harness()
    h.readAttachment.mockResolvedValue("QUJD")
    const e = makeEvent([file("report.pdf")])

    await enrichInboundMedia(e, h.plan, { ...h.deps, extractDocText })

    expect((e.segments[0] as { ocrText?: string }).ocrText).toBe("the report says yes")
  })

  it("does not download a file whose text can never be read back", async () => {
    // Nothing surfaces an inbound cached blob, so caching one is disk churn.
    const extractDocText = jest.fn()
    const h = harness()
    await enrichInboundMedia(makeEvent([file("clip.mp4")]), h.plan, { ...h.deps, extractDocText })
    expect(h.readAttachment).not.toHaveBeenCalled()
    expect(extractDocText).not.toHaveBeenCalled()
  })

  it("does not re-extract a file that already carries text", async () => {
    const extractDocText = jest.fn()
    const h = harness()
    const seg = { ...(file("report.pdf") as object), ocrText: "already" } as MessageSegment
    await enrichInboundMedia(makeEvent([seg]), h.plan, { ...h.deps, extractDocText })
    expect(h.readAttachment).not.toHaveBeenCalled()
    expect(extractDocText).not.toHaveBeenCalled()
  })

  it("leaves ocrText unset when the extractor yields only whitespace", async () => {
    const extractDocText = jest.fn().mockResolvedValue("   ")
    const h = harness()
    h.readAttachment.mockResolvedValue("QUJD")
    const e = makeEvent([file("report.pdf")])

    await enrichInboundMedia(e, h.plan, { ...h.deps, extractDocText })

    expect((e.segments[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("uses processDocumentAsync, labelled by the plan, as the default extractor", async () => {
    const h = harness()
    h.readAttachment.mockResolvedValue("QUJD")
    const e = makeEvent([file("report.pdf")])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(mockProcessDoc).toHaveBeenCalledWith(
      "test-inbound:report.pdf",
      "report.pdf",
      expect.anything()
    )
    expect((e.segments[0] as { ocrText?: string }).ocrText).toBe("extracted pdf text")
  })

  it("survives an extractor that throws", async () => {
    const extractDocText = jest.fn().mockRejectedValue(new Error("corrupt"))
    const h = harness()
    h.readAttachment.mockResolvedValue("QUJD")
    const e = makeEvent([file("report.pdf")])

    await expect(
      enrichInboundMedia(e, h.plan, { ...h.deps, extractDocText })
    ).resolves.toBeUndefined()
    expect((e.segments[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })
})

describe("enrichInboundMedia — best-effort guards", () => {
  it("is inert off-desktop, where the attachment commands do not exist", async () => {
    const h = harness()
    await enrichInboundMedia(makeEvent([image()]), h.plan, { ...h.deps, enabled: false })
    expect(h.readAttachment).not.toHaveBeenCalled()
  })

  it("defaults to isTauri() — false under Jest — when `enabled` is omitted", async () => {
    const h = harness()
    const { enabled: _drop, ...deps } = h.deps
    void _drop
    await enrichInboundMedia(makeEvent([image()]), h.plan, deps)
    expect(h.readAttachment).not.toHaveBeenCalled()
  })

  it("keeps the marker when the bytes are over the inline cap", async () => {
    const h = harness()
    h.readAttachment.mockResolvedValue(null)
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(h.fetchAttachment).toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("keeps the marker when the resolver gives up", async () => {
    const h = harness({ source: async () => undefined })
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(h.fetchAttachment).not.toHaveBeenCalled()
    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
  })

  it("one unreadable attachment does not cost the others", async () => {
    const h = harness({
      source: jest
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ url: "https://dl/b" }),
    })
    h.readAttachment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("SECOND")
    const e = makeEvent([image("https://x/1.png"), image("https://x/2.png")])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()
    expect((e.segments[1] as { dataBase64?: string }).dataBase64).toBe("SECOND")
  })

  it("never re-downloads a segment that already carries bytes", async () => {
    const h = harness()
    h.readAttachment.mockResolvedValue("CACHED")
    const seg = { type: "image" as const, url: "https://x/a.png", dataBase64: "ALREADY" }

    await enrichInboundMedia(makeEvent([seg as MessageSegment]), h.plan, h.deps)

    expect(h.readAttachment).not.toHaveBeenCalled()
    expect((seg as { dataBase64?: string }).dataBase64).toBe("ALREADY")
  })
})

// A 1x1 JPEG and a 1x1 PNG, base64 — only the magic number matters here.
const JPEG_B64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBk"
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"

describe("sniffImageMediaType", () => {
  it("names the type from the bytes themselves", () => {
    expect(sniffImageMediaType(JPEG_B64)).toBe("image/jpeg")
    expect(sniffImageMediaType(PNG_B64)).toBe("image/png")
    expect(sniffImageMediaType(btoa("GIF89a-and-more"))).toBe("image/gif")
    expect(sniffImageMediaType(btoa("RIFF____WEBPVP8 "))).toBe("image/webp")
  })

  it("returns undefined for bytes it cannot name, and never throws", () => {
    expect(sniffImageMediaType(btoa("not an image at all"))).toBeUndefined()
    expect(sniffImageMediaType("")).toBeUndefined()
    expect(sniffImageMediaType("!!!!not base64!!!!")).toBeUndefined()
  })
})

describe("enrichInboundMedia — media type", () => {
  beforeEach(() => __resetInboundMediaOverCapMemo())

  it("declares what the bytes are, not what the plan guessed", () => {
    // `inboundEventToSendContent` passes `mimeType` through as the model's
    // `media_type`, and a provider rejects one that disagrees with the payload.
    // OneBot names no type, so the guess used to be a hard-coded `image/png`.
    const h = harness({ defaultImageMime: "image/png" })
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValue(JPEG_B64)
    const e = makeEvent([image()])

    return enrichInboundMedia(e, h.plan, h.deps).then(() => {
      expect(e.segments[0]).toMatchObject({ mimeType: "image/jpeg", dataBase64: JPEG_B64 })
    })
  })

  it("gets the type right on a cache hit, where `source` never runs", async () => {
    // The resolved type is only learned on the miss path, so a redelivery used
    // to fall through to `defaultImageMime` however wrong it was.
    const h = harness({ defaultImageMime: "image/jpeg" })
    h.readAttachment.mockResolvedValue(PNG_B64)
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(h.source).not.toHaveBeenCalled()
    expect(e.segments[0]).toMatchObject({ mimeType: "image/png" })
  })

  it("falls back to the plan's default only when the bytes are unrecognisable", async () => {
    const h = harness({ defaultImageMime: "image/jpeg" })
    h.readAttachment.mockResolvedValue(btoa("mystery-format"))
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(e.segments[0]).toMatchObject({ mimeType: "image/jpeg" })
  })
})

describe("enrichInboundMedia — over-cap media", () => {
  beforeEach(() => __resetInboundMediaOverCapMemo())

  it("stops re-resolving a cached file that is bigger than the cap", async () => {
    // `connectors_attachment_read` answers null both for "not cached" and for
    // "cached but over the cap", so without the memo every later message
    // naming this file pays `plan.source` again — a getFile round trip on
    // Telegram, a keyring read on Lark and Slack.
    const h = harness()
    h.fetchAttachment.mockResolvedValue({ cacheKey: "k", remoteRef: "r", sizeBytes: 20_000_000 })
    h.readAttachment.mockResolvedValue(null)

    const first = makeEvent([image()])
    await enrichInboundMedia(first, h.plan, h.deps)
    expect(h.source).toHaveBeenCalledTimes(1)
    // The read that would answer null again is skipped too.
    expect(h.readAttachment).toHaveBeenCalledTimes(1)
    expect((first.segments[0] as { dataBase64?: string }).dataBase64).toBeUndefined()

    const second = makeEvent([image()])
    await enrichInboundMedia(second, h.plan, h.deps)
    expect(h.source).toHaveBeenCalledTimes(1)
    expect(h.fetchAttachment).toHaveBeenCalledTimes(1)
  })

  it("keeps serving a file that fits", async () => {
    const h = harness()
    h.fetchAttachment.mockResolvedValue({ cacheKey: "k", remoteRef: "r", sizeBytes: 1024 })
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValue(PNG_B64)
    const e = makeEvent([image()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect((e.segments[0] as { dataBase64?: string }).dataBase64).toBe(PNG_B64)
  })
})

describe("enrichInboundMedia — a picture sent as a document", () => {
  beforeEach(() => __resetInboundMediaOverCapMemo())

  const imageFile = (): MessageSegment => ({
    type: "file",
    url: "https://cdn.example.com/shot",
    name: "screenshot.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
  })

  it("inlines the bytes for the OCR pass instead of skipping it", async () => {
    // Telegram's "send as file" path — the standard way to send a screenshot
    // you want read accurately. `jpg` is not an extractable document
    // extension, so it used to be dropped before any download.
    const h = harness()
    h.readAttachment.mockResolvedValueOnce(null).mockResolvedValue(JPEG_B64)
    const e = makeEvent([imageFile()])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(e.segments[0]).toMatchObject({
      type: "file",
      dataBase64: JPEG_B64,
      mimeType: "image/jpeg",
    })
    // Not the document extractor — there is no text in a JPEG.
    expect(mockProcessDoc).not.toHaveBeenCalled()
  })

  it("still leaves a file nothing can read as its marker", async () => {
    const h = harness()
    const e = makeEvent([
      {
        type: "file",
        url: "https://cdn.example.com/blob",
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: 10,
      },
    ])

    await enrichInboundMedia(e, h.plan, h.deps)

    expect(h.readAttachment).not.toHaveBeenCalled()
  })
})
