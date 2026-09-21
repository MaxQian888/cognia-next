import { invoke } from "@tauri-apps/api/core"
import { resolveLarkMediaKeys } from "./upload"
import type { MessageSegment } from "@/types/connectors/segment"

const mockInvoke = invoke as jest.Mock

describe("resolveLarkMediaKeys", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it("uploads inline image bytes instead of treating their data URL as a platform key", async () => {
    mockInvoke.mockResolvedValueOnce("img_uploaded")
    const url = "data:image/png;base64,AQID"
    const out = await resolveLarkMediaKeys([{ type: "image", url }], {
      getAccessToken: async () => "token",
    })
    expect(out).toEqual([{ type: "image", url: "img_uploaded" }])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_image", {
      accessToken: "token",
      sourceUrl: url,
      imageType: undefined,
    })
  })

  it("passes through non-media segments unchanged", async () => {
    const segments: MessageSegment[] = [
      { type: "text", text: "hi" },
      { type: "mention", userId: "ou_user_001" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })
    expect(out).toEqual(segments)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("passes through media segments that already carry a Lark key (no ://)", async () => {
    const segments: MessageSegment[] = [
      { type: "voice", url: "file_v3_existing_voice" },
      { type: "image", url: "img_v3_existing" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })
    expect(out).toEqual(segments)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("uploads a remote voice URL via connectors_lark_upload_file with opus + duration", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_new_voice")
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://media.example.com/clip.opus", durationSec: 3.5 },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([{ type: "voice", url: "file_v3_new_voice", durationSec: 3.5 }])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_file", {
      accessToken: "t-token",
      sourceUrl: "https://media.example.com/clip.opus",
      fileType: "opus",
      fileName: "clip.opus",
      durationMs: 3500,
    })
  })

  it("degrades a non-opus voice source to a file attachment (unplayable as audio otherwise)", async () => {
    // Lark's audio bubble plays only opus; uploading an mp3 with
    // file_type=opus "succeeds" but produces a broken voice message.
    mockInvoke.mockResolvedValueOnce("file_v3_mp3_as_file")
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://media.example.com/memo.mp3", durationSec: 12 },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([
      {
        type: "file",
        url: "file_v3_mp3_as_file",
        name: "memo.mp3",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
    ])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_file", {
      accessToken: "t-token",
      sourceUrl: "https://media.example.com/memo.mp3",
      fileType: "stream",
      fileName: "memo.mp3",
      durationMs: undefined,
    })
  })

  it("keeps an already-resolved voice key untouched even without an opus extension", async () => {
    const segments: MessageSegment[] = [{ type: "voice", url: "file_v3_resolved_voice" }]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })
    expect(out).toEqual(segments)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("uploads a remote video URL via connectors_lark_upload_file with mp4", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_new_video")
    const segments: MessageSegment[] = [
      { type: "video", url: "https://media.example.com/demo.mp4" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([{ type: "video", url: "file_v3_new_video" }])
    const args = mockInvoke.mock.calls[0][1] as { fileType: string; fileName: string }
    expect(args.fileType).toBe("mp4")
    expect(args.fileName).toBe("demo.mp4")
  })

  it("uploads a remote image URL via connectors_lark_upload_image", async () => {
    mockInvoke.mockResolvedValueOnce("img_v3_new")
    const segments: MessageSegment[] = [
      { type: "image", url: "https://cdn.example.com/photo.png", alt: "hi" },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out).toEqual([{ type: "image", url: "img_v3_new", alt: "hi" }])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_image", {
      accessToken: "t-token",
      sourceUrl: "https://cdn.example.com/photo.png",
      imageType: undefined,
    })
  })

  it("uploads a remote file URL via connectors_lark_upload_file with extension-derived type", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_new_doc")
    const segments: MessageSegment[] = [
      {
        type: "file",
        url: "https://docs.example.com/report.pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      },
    ]
    const out = await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => "t-token",
    })

    expect(out[0]).toMatchObject({ type: "file", url: "file_v3_new_doc", name: "report.pdf" })
    const args = mockInvoke.mock.calls[0][1] as { fileType: string; fileName: string }
    expect(args.fileType).toBe("pdf")
    expect(args.fileName).toBe("report.pdf")
  })

  it("falls back to file_type=stream for unknown extensions", async () => {
    mockInvoke.mockResolvedValueOnce("file_v3_blob")
    const segments: MessageSegment[] = [
      {
        type: "file",
        url: "https://blob.example.com/payload.dat",
        name: "payload.dat",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      },
    ]
    await resolveLarkMediaKeys(segments, { getAccessToken: async () => "t-token" })
    const args = mockInvoke.mock.calls[0][1] as { fileType: string }
    expect(args.fileType).toBe("stream")
  })

  it("only calls getAccessToken once even with multiple uploads", async () => {
    mockInvoke
      .mockResolvedValueOnce("file_v3_a")
      .mockResolvedValueOnce("img_v3_b")
      .mockResolvedValueOnce("file_v3_c")

    let tokenFetches = 0
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://a.example.com/x.opus", durationSec: 1 },
      { type: "image", url: "https://b.example.com/y.png" },
      { type: "video", url: "https://c.example.com/z.mp4" },
    ]
    await resolveLarkMediaKeys(segments, {
      getAccessToken: async () => {
        tokenFetches++
        return "t-token"
      },
    })
    expect(tokenFetches).toBe(1)
    expect(mockInvoke).toHaveBeenCalledTimes(3)
  })

  it("uses the upload cache to short-circuit duplicate URLs", async () => {
    const cache = new Map<string, string>()
    mockInvoke.mockResolvedValueOnce("file_v3_cached")

    const segs: MessageSegment[] = [
      { type: "voice", url: "https://dup.example.com/v.opus", durationSec: 2 },
    ]

    const a = await resolveLarkMediaKeys(segs, {
      getAccessToken: async () => "t-token",
      uploadCache: cache,
    })
    expect(a[0]).toMatchObject({ type: "voice", url: "file_v3_cached" })
    expect(cache.get("https://dup.example.com/v.opus")).toBe("file_v3_cached")

    // Second call — same URL — should NOT re-invoke
    const b = await resolveLarkMediaKeys(segs, {
      getAccessToken: async () => "t-token",
      uploadCache: cache,
    })
    expect(b[0]).toMatchObject({ type: "voice", url: "file_v3_cached" })
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it("propagates upload errors (so the outbound runner can deadletter)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Lark upload HTTP 500: server error"))
    const segments: MessageSegment[] = [
      { type: "voice", url: "https://broken.example.com/x.opus", durationSec: 1 },
    ]
    await expect(
      resolveLarkMediaKeys(segments, { getAccessToken: async () => "t-token" })
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe("resolveLarkMediaKeys — A2UI card images", () => {
  it("uploads bound image URLs and writes the key into the cloned component", async () => {
    mockInvoke.mockResolvedValueOnce("img_v3_bound")
    const seg: Extract<MessageSegment, { type: "a2ui" }> = {
      type: "a2ui",
      surfaceId: "bound-image",
      plainTextMirror: "Diagram",
      content: {
        rootId: "image",
        dataModel: { imageUrl: "https://cdn.example.com/bound.png" },
        components: { image: { component: "Image", src: { path: "/imageUrl" } } },
      },
    }
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "token" })
    const result = out[0] as typeof seg
    expect(result.content.components.image).toMatchObject({ src: "img_v3_bound" })
    expect(seg.content.components.image).toMatchObject({ src: { path: "/imageUrl" } })
  })

  function a2uiSegment(src: string): MessageSegment {
    return {
      type: "a2ui",
      surfaceId: "sfc_1",
      plainTextMirror: "[image]",
      content: {
        rootId: "root",
        dataModel: {},
        components: {
          root: { component: "Card", children: ["img1"] },
          img1: { component: "Image", src, alt: "diagram" },
        },
      },
    }
  }

  beforeEach(() => {
    ;(invoke as jest.Mock).mockReset()
  })

  it("uploads remote card images and swaps src for the image_key (clone, no mutation)", async () => {
    ;(invoke as jest.Mock).mockResolvedValueOnce("img_v3_card_1")
    const seg = a2uiSegment("https://cdn.example.com/diagram.png")
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })

    const outSeg = out[0] as Extract<MessageSegment, { type: "a2ui" }>
    expect((outSeg.content.components.img1 as { src?: string }).src).toBe("img_v3_card_1")
    // The original segment is untouched — retries re-serialize from the
    // persisted request.
    expect(
      (
        (seg as Extract<MessageSegment, { type: "a2ui" }>).content.components.img1 as {
          src?: string
        }
      ).src
    ).toBe("https://cdn.example.com/diagram.png")
    expect(invoke).toHaveBeenCalledWith("connectors_lark_upload_image", {
      accessToken: "t-token",
      sourceUrl: "https://cdn.example.com/diagram.png",
      imageType: undefined,
    })
  })

  it("leaves already-resolved image keys untouched (no upload)", async () => {
    const seg = a2uiSegment("img_v3_already")
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    expect(out[0]).toBe(seg)
    expect(invoke).not.toHaveBeenCalled()
  })

  it("degrades per-URL on upload failure (URL kept → card falls back to a link)", async () => {
    ;(invoke as jest.Mock).mockRejectedValueOnce(new Error("upload boom"))
    const seg = a2uiSegment("https://cdn.example.com/broken.png")
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    const outSeg = out[0] as Extract<MessageSegment, { type: "a2ui" }>
    expect((outSeg.content.components.img1 as { src?: string }).src).toBe(
      "https://cdn.example.com/broken.png"
    )
  })

  it("reuses the uploadCache across calls for the same URL", async () => {
    const cache = new Map<string, string>([
      ["https://cdn.example.com/diagram.png", "img_v3_cached"],
    ])
    const seg = a2uiSegment("https://cdn.example.com/diagram.png")
    const out = await resolveLarkMediaKeys([seg], {
      getAccessToken: async () => "t-token",
      uploadCache: cache,
    })
    const outSeg = out[0] as Extract<MessageSegment, { type: "a2ui" }>
    expect((outSeg.content.components.img1 as { src?: string }).src).toBe("img_v3_cached")
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("resolveLarkMediaKeys — Lark card payload images", () => {
  const imgEl = (imgKey: string, alt = "diagram") => ({
    tag: "img",
    img_key: imgKey,
    alt: { tag: "plain_text", content: alt },
  })
  const mdEl = (content: string) => ({ tag: "markdown", content })

  function cardSegment(elements: Record<string, unknown>[]): MessageSegment {
    return {
      type: "card",
      card: {
        kind: "lark",
        payload: { schema: "2.0", config: { update_multi: true }, body: { elements } },
      },
    }
  }

  function cardElements(seg: MessageSegment): Record<string, unknown>[] {
    if (seg.type !== "card") throw new Error("expected card segment")
    const payload = seg.card.payload as { body: { elements: Record<string, unknown>[] } }
    return payload.body.elements
  }

  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it("uploads an http img_key placeholder and swaps in the real image_key", async () => {
    mockInvoke.mockResolvedValueOnce("img_v3_result")
    const seg = cardSegment([
      mdEl("before"),
      imgEl("https://cdn.example.com/d.png", "diagram"),
      mdEl("after"),
    ])
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })

    const els = cardElements(out[0])
    expect(els.map((el) => el.tag)).toEqual(["markdown", "img", "markdown"])
    expect(els[1].img_key).toBe("img_v3_result")
    expect(els[1].alt).toEqual({ tag: "plain_text", content: "diagram" })
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_image", {
      accessToken: "t-token",
      sourceUrl: "https://cdn.example.com/d.png",
      imageType: undefined,
    })
    // The persisted request payload stays byte-identical for retries.
    expect(cardElements(seg)[1].img_key).toBe("https://cdn.example.com/d.png")
  })

  it("uploads a data: img_key placeholder (inline bytes path)", async () => {
    mockInvoke.mockResolvedValueOnce("img_v3_inline")
    const seg = cardSegment([imgEl("data:image/png;base64,AQID")])
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    expect(cardElements(out[0])[0].img_key).toBe("img_v3_inline")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_lark_upload_image", {
      accessToken: "t-token",
      sourceUrl: "data:image/png;base64,AQID",
      imageType: undefined,
    })
  })

  it("degrades a failed http(s) upload to a markdown link element in place", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("Lark upload HTTP 500"))
    const seg = cardSegment([
      mdEl("before"),
      imgEl("https://cdn.example.com/broken.png", "shot"),
      mdEl("after"),
    ])
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    const els = cardElements(out[0])
    expect(els).toEqual([
      mdEl("before"),
      { tag: "markdown", content: "[shot](https://cdn.example.com/broken.png)" },
      mdEl("after"),
    ])
  })

  it("drops a local-path img element (the Lark upload command cannot read files)", async () => {
    const seg = cardSegment([
      mdEl("before"),
      imgEl("/tmp/shot.png"),
      imgEl("./out.webp"),
      imgEl("~/pic.jpg"),
      imgEl("chart.gif"),
      mdEl("after"),
    ])
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    const els = cardElements(out[0])
    expect(els).toEqual([mdEl("before"), mdEl("after")])
    // No upload attempt — local paths are dropped without a network call.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("drops a failed data: upload rather than emitting an unusable data: link", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("decode failed"))
    const seg = cardSegment([mdEl("a"), imgEl("data:image/png;base64,BAD"), mdEl("b")])
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    expect(cardElements(out[0])).toEqual([mdEl("a"), mdEl("b")])
  })

  it("resolves images nested inside form / column_set containers", async () => {
    mockInvoke.mockResolvedValueOnce("img_v3_form").mockResolvedValueOnce("img_v3_col")
    const seg: MessageSegment = {
      type: "card",
      card: {
        kind: "lark",
        payload: {
          schema: "2.0",
          body: {
            elements: [
              {
                tag: "form",
                elements: [imgEl("https://cdn.example.com/form.png")],
              },
              {
                tag: "column_set",
                columns: [{ tag: "column", elements: [imgEl("https://cdn.example.com/col.png")] }],
              },
            ],
          },
        },
      },
    }
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    const els = cardElements(out[0])
    const form = els[0] as { elements: Record<string, unknown>[] }
    const colSet = els[1] as { columns: { elements: Record<string, unknown>[] }[] }
    expect(form.elements[0].img_key).toBe("img_v3_form")
    expect(colSet.columns[0].elements[0].img_key).toBe("img_v3_col")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("leaves already-keyed img elements untouched and returns the same segment", async () => {
    const seg = cardSegment([imgEl("img_v3_already"), mdEl("text")])
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    expect(out[0]).toBe(seg)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("passes non-lark card dialects through untouched", async () => {
    const seg: MessageSegment = {
      type: "card",
      card: { kind: "slack", payload: { blocks: [{ type: "image" }] } },
    }
    const out = await resolveLarkMediaKeys([seg], { getAccessToken: async () => "t-token" })
    expect(out[0]).toBe(seg)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("uploads each distinct source once and reuses the cache", async () => {
    const cache = new Map<string, string>([["https://cdn.example.com/cached.png", "img_v3_cached"]])
    mockInvoke.mockResolvedValueOnce("img_v3_new")
    const seg = cardSegment([
      imgEl("https://cdn.example.com/cached.png"),
      imgEl("https://cdn.example.com/fresh.png"),
      imgEl("https://cdn.example.com/fresh.png"),
    ])
    const out = await resolveLarkMediaKeys([seg], {
      getAccessToken: async () => "t-token",
      uploadCache: cache,
    })
    const els = cardElements(out[0])
    expect(els.map((el) => el.img_key)).toEqual(["img_v3_cached", "img_v3_new", "img_v3_new"])
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})
