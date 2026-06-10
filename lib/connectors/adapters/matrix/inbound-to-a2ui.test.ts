import { matrixInboundToA2UI } from "./inbound-to-a2ui"
import type { MatrixTimelineEvent } from "./parse"

function ev(content: MatrixTimelineEvent["content"]): MatrixTimelineEvent {
  return {
    type: "m.room.message",
    event_id: "$evt",
    sender: "@alice:example.org",
    origin_server_ts: 1,
    content,
  }
}

describe("matrixInboundToA2UI", () => {
  it("returns null for missing / empty content", () => {
    expect(matrixInboundToA2UI(undefined as unknown as MatrixTimelineEvent)).toBeNull()
    expect(matrixInboundToA2UI(ev({}))).toBeNull()
  })

  it("maps plain text", () => {
    const out = matrixInboundToA2UI(ev({ msgtype: "m.text", body: "hello" }))
    expect(out).toEqual({
      v: 1,
      source: "matrix",
      body: [{ kind: "text", text: "hello" }],
      raw: expect.any(Object),
    })
  })

  it("maps m.image to an image node with dimensions", () => {
    const out = matrixInboundToA2UI(
      ev({ msgtype: "m.image", body: "pic.png", url: "mxc://srv/abc", info: { w: 320, h: 200 } })
    )
    expect(out!.body[0]).toEqual({
      kind: "image",
      url: "mxc://srv/abc",
      alt: "pic.png",
      width: 320,
      height: 200,
    })
  })

  it("maps m.file / m.video / m.audio to link nodes", () => {
    expect(
      matrixInboundToA2UI(ev({ msgtype: "m.file", url: "mxc://s/f", filename: "report.pdf" }))!
        .body[0]
    ).toEqual({ kind: "link", href: "mxc://s/f", label: "report.pdf" })
    expect(matrixInboundToA2UI(ev({ msgtype: "m.video", url: "mxc://s/v" }))!.body[0]).toEqual({
      kind: "link",
      href: "mxc://s/v",
      label: "Video",
    })
    expect(matrixInboundToA2UI(ev({ msgtype: "m.audio", url: "mxc://s/a" }))!.body[0]).toEqual({
      kind: "link",
      href: "mxc://s/a",
      label: "Voice message",
    })
  })

  it("emits a reply_context node and strips the reply fallback from the body", () => {
    const out = matrixInboundToA2UI(
      ev({
        msgtype: "m.text",
        body: "> <@bob:x> original\n\nmy reply",
        "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } },
      })
    )
    expect(out!.body).toEqual([
      { kind: "reply_context", replyToMessageId: "$orig" },
      { kind: "text", text: "my reply" },
    ])
  })

  it("maps m.mentions to mention nodes with friendly localparts", () => {
    const out = matrixInboundToA2UI(
      ev({ msgtype: "m.text", body: "hi", "m.mentions": { user_ids: ["@bot:srv"] } })
    )
    expect(out!.body).toContainEqual({ kind: "mention", handle: "@bot:srv", resolved: "bot" })
  })

  it("uses the media body as the label when present, else a default", () => {
    expect(
      matrixInboundToA2UI(ev({ msgtype: "m.video", url: "mxc://s/v", body: "clip.mp4" }))!.body[0]
    ).toEqual({ kind: "link", href: "mxc://s/v", label: "clip.mp4" })
    expect(
      matrixInboundToA2UI(ev({ msgtype: "m.audio", url: "mxc://s/a", body: "note.ogg" }))!.body[0]
    ).toEqual({ kind: "link", href: "mxc://s/a", label: "note.ogg" })
    // m.file: no filename → falls back to body, then to "Attachment".
    expect(
      matrixInboundToA2UI(ev({ msgtype: "m.file", url: "mxc://s/f", body: "doc" }))!.body[0]
    ).toEqual({
      kind: "link",
      href: "mxc://s/f",
      label: "doc",
    })
    expect(matrixInboundToA2UI(ev({ msgtype: "m.file", url: "mxc://s/f" }))!.body[0]).toEqual({
      kind: "link",
      href: "mxc://s/f",
      label: "Attachment",
    })
  })

  it("falls back to text when a media msgtype is missing its url", () => {
    const out = matrixInboundToA2UI(ev({ msgtype: "m.image", body: "caption only" }))
    expect(out!.body).toEqual([{ kind: "text", text: "caption only" }])
  })

  it("renders edited content from m.new_content", () => {
    const out = matrixInboundToA2UI(
      ev({
        msgtype: "m.text",
        body: "* edited",
        "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
        "m.new_content": { msgtype: "m.text", body: "edited" },
      })
    )
    expect(out!.body).toEqual([{ kind: "text", text: "edited" }])
  })
})
