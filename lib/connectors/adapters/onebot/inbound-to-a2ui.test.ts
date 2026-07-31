import { onebotInboundToA2UI } from "./inbound-to-a2ui"

describe("onebotInboundToA2UI", () => {
  it("returns null on missing message", () => {
    expect(onebotInboundToA2UI({})).toBeNull()
  })

  it("returns null for an empty string message", () => {
    expect(onebotInboundToA2UI({ message: "" })).toBeNull()
  })

  it("maps a plain string message into a single text node", () => {
    const out = onebotInboundToA2UI({ message: "hello" })
    expect(out!.body).toEqual([{ kind: "text", text: "hello" }])
  })

  it("maps text + at + image segments", () => {
    const out = onebotInboundToA2UI({
      message: [
        { type: "at", data: { qq: "12345", name: "Alice" } },
        { type: "text", data: { text: " hi there" } },
        { type: "image", data: { url: "https://example.com/a.png", summary: "pic" } },
      ],
    })
    expect(out!.body).toEqual([
      { kind: "mention", handle: "12345", resolved: "Alice" },
      { kind: "text", text: " hi there" },
      { kind: "image", url: "https://example.com/a.png", alt: "pic" },
    ])
  })

  it("maps reply segment into reply_context", () => {
    const out = onebotInboundToA2UI({
      message: [{ type: "reply", data: { id: "9876" } }],
    })
    expect(out!.body[0]).toEqual({ kind: "reply_context", replyToMessageId: "9876" })
  })

  it("maps share segment into a card", () => {
    const out = onebotInboundToA2UI({
      message: [
        {
          type: "share",
          data: { title: "Doc", content: "Summary", url: "https://example.com" },
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "card",
      title: "Doc",
      children: [
        { kind: "text", text: "Summary" },
        { kind: "link", href: "https://example.com", label: "https://example.com" },
      ],
    })
  })

  it("maps record + video segments into links", () => {
    const out = onebotInboundToA2UI({
      message: [
        { type: "record", data: { file: "x.silk" } },
        { type: "video", data: { url: "https://example.com/v.mp4" } },
      ],
    })
    expect(out!.body[0]).toEqual({
      kind: "link",
      href: "cq-record:x.silk",
      label: "Voice message",
    })
    expect(out!.body[1]).toEqual({
      kind: "link",
      href: "https://example.com/v.mp4",
      label: "Video",
    })
  })

  it("maps v12 segment names (mention / voice / file_id)", () => {
    const out = onebotInboundToA2UI({
      message: [
        { type: "mention", data: { user_id: "200001" } },
        { type: "voice", data: { file_id: "voice-fid" } },
        { type: "image", data: { file_id: "img-fid" } },
        { type: "video", data: { file_id: "vid-fid" } },
      ],
    })
    expect(out!.body).toEqual([
      { kind: "mention", handle: "200001", resolved: undefined },
      { kind: "link", href: "cq-record:voice-fid", label: "Voice message" },
      { kind: "image", url: "img-fid", alt: undefined },
      { kind: "link", href: "cq-video:vid-fid", label: "Video" },
    ])
  })

  it("prefers a direct url over file/file_id for v12 voice", () => {
    const out = onebotInboundToA2UI({
      message: [{ type: "voice", data: { url: "https://a.com/v.amr", file_id: "fid" } }],
    })
    expect(out!.body[0]).toEqual({
      kind: "link",
      href: "https://a.com/v.amr",
      label: "Voice message",
    })
  })

  it("skips unknown segment types but keeps known ones", () => {
    const out = onebotInboundToA2UI({
      message: [
        { type: "text", data: { text: "yes" } },
        { type: "weird-type-we-dont-know" } as never,
        { type: "face", data: { id: "12" } },
      ],
    })
    expect(out!.body).toEqual([
      { kind: "text", text: "yes" },
      { kind: "text", text: "[face:12]", emphasis: "muted" },
    ])
  })
})
