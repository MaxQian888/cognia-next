import type { OutboundRequest } from "@/types/connectors/outbound"
import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import {
  a2uiToMatrixHtml,
  escapeHtml,
  mdToMatrixHtml,
  serializeEdit,
  serializeMediaFailureNotice,
  serializeMediaLinkFallback,
  serializeOutbound,
  serializeReaction,
} from "./serialize"
import type { MatrixSendContent, MatrixSerializedContent } from "./serialize"

function req(segments: MessageSegment[], extra: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    conversationRef: { platform: "matrix", adapterId: "mx-1", roomId: "!r:s" },
    segments,
    metadata: { idempotencyKey: "idem-1" },
    ...extra,
  }
}

/** Narrow a serialized content to a text send content for assertions. */
const asSend = (c: MatrixSerializedContent): MatrixSendContent => c as MatrixSendContent

describe("escapeHtml / mdToMatrixHtml", () => {
  it("escapes HTML special chars", () => {
    expect(escapeHtml("<b>&\"'")).toBe("&lt;b&gt;&amp;&quot;&#39;")
  })
  it("converts bold, italic, code, links, newlines", () => {
    expect(mdToMatrixHtml("**bold**")).toBe("<strong>bold</strong>")
    expect(mdToMatrixHtml("a *it* b")).toBe("a <em>it</em> b")
    expect(mdToMatrixHtml("`x`")).toBe("<code>x</code>")
    expect(mdToMatrixHtml("[t](https://e.com)")).toBe('<a href="https://e.com">t</a>')
    expect(mdToMatrixHtml("a\nb")).toBe("a<br/>b")
  })
  it("escapes before formatting so injection is neutralised", () => {
    expect(mdToMatrixHtml("<script>")).toBe("&lt;script&gt;")
  })
})

describe("serializeOutbound", () => {
  it("renders plain text as m.notice without a formatted_body", () => {
    const { contents } = serializeOutbound(req([{ type: "text", text: "hi" }]))
    expect(contents).toHaveLength(1)
    // m.notice is the bot convention — well-behaved bots ignore m.notice,
    // which prevents bot-to-bot reply loops.
    expect(contents[0]).toEqual({ msgtype: "m.notice", body: "hi" })
  })

  it("renders markdown with an org.matrix.custom.html formatted_body", () => {
    const { contents } = serializeOutbound(req([{ type: "markdown", md: "**hey**" }]))
    expect(asSend(contents[0]).format).toBe("org.matrix.custom.html")
    expect(asSend(contents[0]).formatted_body).toBe("<strong>hey</strong>")
    expect(asSend(contents[0]).body).toBe("**hey**")
  })

  it("renders a mention with m.mentions + matrix.to link", () => {
    const { contents } = serializeOutbound(
      req([{ type: "mention", userId: "@u:s", displayName: "U" }])
    )
    expect(asSend(contents[0])["m.mentions"]).toEqual({ user_ids: ["@u:s"] })
    expect(asSend(contents[0]).formatted_body).toContain('href="https://matrix.to/#/%40u%3As"')
  })

  it("emits media chunks instead of degrading media to link text", () => {
    const { contents } = serializeOutbound(req([{ type: "image", url: "https://e.com/p.png" }]))
    expect(contents).toEqual([
      {
        kind: "media",
        segment: { type: "image", url: "https://e.com/p.png" },
      },
    ])
  })

  it("applies a reply relation to the first chunk", () => {
    const { contents } = serializeOutbound(
      req([{ type: "text", text: "re" }], { replyTo: { messageId: "$orig" } })
    )
    expect(asSend(contents[0])["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$orig" } })
  })

  it("applies a thread relation with fallback in-reply-to", () => {
    const { contents } = serializeOutbound(
      req([{ type: "text", text: "t" }], { threadId: "$root" })
    )
    expect(asSend(contents[0])["m.relates_to"]).toMatchObject({
      rel_type: "m.thread",
      event_id: "$root",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root" },
    })
  })

  it("applies the thread relation to every chunk, media included", () => {
    const { contents } = serializeOutbound(
      req(
        [
          { type: "text", text: "look" },
          { type: "image", url: "https://e.com/p.png" },
          { type: "text", text: "tail" },
        ],
        { threadId: "$root" }
      )
    )
    expect(contents).toHaveLength(3)
    const rel = {
      rel_type: "m.thread",
      event_id: "$root",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$root" },
    }
    expect(asSend(contents[0])["m.relates_to"]).toMatchObject(rel)
    expect(contents[1]).toMatchObject({ kind: "media", relatesTo: rel })
    expect(asSend(contents[2])["m.relates_to"]).toMatchObject(rel)
  })

  it("applies a plain reply relation to the first chunk even when it is media", () => {
    const { contents } = serializeOutbound(
      req(
        [
          { type: "image", url: "https://e.com/p.png" },
          { type: "text", text: "caption" },
        ],
        { replyTo: { messageId: "$orig" } }
      )
    )
    expect(contents[0]).toMatchObject({
      kind: "media",
      relatesTo: { "m.in_reply_to": { event_id: "$orig" } },
    })
    expect(asSend(contents[1])["m.relates_to"]).toBeUndefined()
  })

  it("serializeMediaLinkFallback renders the pre-upload link line", () => {
    expect(serializeMediaLinkFallback({ type: "image", url: "https://e.com/p.png" })).toEqual({
      msgtype: "m.notice",
      body: "[image] https://e.com/p.png",
      format: "org.matrix.custom.html",
      formatted_body: '<a href="https://e.com/p.png">[image]</a>',
    })
  })

  it("serializeMediaFailureNotice names the attachment without leaking a url", () => {
    expect(serializeMediaFailureNotice("secret.pdf")).toEqual({
      msgtype: "m.notice",
      body: "[attachment upload failed: secret.pdf]",
    })
  })

  it("strips the roomId| composite prefix from reply/thread targets", () => {
    const { contents } = serializeOutbound(
      req([{ type: "text", text: "re" }], {
        replyTo: { messageId: "!r:s|$orig" },
        threadId: "!r:s|$root",
      })
    )
    expect(asSend(contents[0])["m.relates_to"]).toMatchObject({
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: "$orig" },
    })
  })

  it("projects an A2UI surface and binds when interactive", () => {
    const content: A2UISegmentContent = {
      rootId: "root",
      dataModel: {},
      components: {
        root: { component: "Card", title: "Choose", children: ["b1", "b2"] },
        b1: { component: "Button", text: "Yes", action: "yes" },
        b2: { component: "Button", text: "No", action: "no" },
      },
    }
    const { contents, a2uiBinding } = serializeOutbound(
      req([{ type: "a2ui", surfaceId: "surf-1", content, plainTextMirror: "Choose: Yes / No" }])
    )
    expect(a2uiBinding).toEqual({ surfaceId: "surf-1" })
    expect(asSend(contents[0]).format).toBe("org.matrix.custom.html")
    expect(asSend(contents[0]).formatted_body).toContain("<strong>Choose</strong>")
    expect(asSend(contents[0]).formatted_body).toContain("1. <strong>Yes</strong>")
    expect(asSend(contents[0]).formatted_body).toContain("2. <strong>No</strong>")
    expect(asSend(contents[0]).formatted_body).toContain("Reply to this message")
    // Mirror is the plain-text fallback body.
    expect(asSend(contents[0]).body).toBe("Choose: Yes / No")
  })

  it("does not bind a non-interactive A2UI surface", () => {
    const content: A2UISegmentContent = {
      rootId: "root",
      dataModel: {},
      components: { root: { component: "Text", text: "just text" } },
    }
    const { a2uiBinding, contents } = serializeOutbound(
      req([{ type: "a2ui", surfaceId: "s", content, plainTextMirror: "just text" }])
    )
    expect(a2uiBinding).toBeUndefined()
    expect(asSend(contents[0]).formatted_body).toContain("just text")
  })

  it("flushes buffered text before an A2UI surface (preserves order)", () => {
    const content: A2UISegmentContent = {
      rootId: "root",
      dataModel: {},
      components: { root: { component: "Text", text: "card" } },
    }
    const { contents } = serializeOutbound(
      req([
        { type: "text", text: "intro" },
        { type: "a2ui", surfaceId: "s", content, plainTextMirror: "card" },
      ])
    )
    expect(contents).toHaveLength(2)
    expect(asSend(contents[0]).body).toBe("intro")
    expect(asSend(contents[1]).body).toBe("card")
  })
})

describe("a2uiToMatrixHtml", () => {
  it("numbers select options", () => {
    const content: A2UISegmentContent = {
      rootId: "root",
      dataModel: {},
      components: {
        root: { component: "Select", label: "Pick", options: [{ label: "A" }, { label: "B" }] },
      },
    }
    const { html, hasInteractive } = a2uiToMatrixHtml(content)
    expect(hasInteractive).toBe(true)
    expect(html).toContain("Pick:")
    expect(html).toContain("1. A")
    expect(html).toContain("2. B")
  })
})

describe("serializeEdit", () => {
  it("builds an m.replace content with new_content", () => {
    const content = serializeEdit("$target", req([{ type: "markdown", md: "**v2**" }]))
    expect(content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$target" })
    expect(content["m.new_content"]).toMatchObject({
      msgtype: "m.notice",
      body: "**v2**",
      format: "org.matrix.custom.html",
      formatted_body: "<strong>v2</strong>",
    })
    expect(content.body).toBe("* **v2**")
  })

  it("accepts the roomId|eventId composite as the edit target", () => {
    const content = serializeEdit("!r:s|$target", req([{ type: "text", text: "v2" }]))
    expect(content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$target" })
  })

  it("carries m.mentions inside m.new_content", () => {
    const content = serializeEdit(
      "$target",
      req([
        { type: "text", text: "ping " },
        { type: "mention", userId: "@u:s", displayName: "U" },
      ])
    )
    expect(content["m.new_content"]?.["m.mentions"]).toEqual({ user_ids: ["@u:s"] })
  })

  it("renders media segments as a link line instead of an empty body", () => {
    // Regression: renderSegments dropped media to nothing, so editing a message
    // to an image produced an empty body (the whole image was lost).
    const content = serializeEdit("$target", req([{ type: "image", url: "https://e.com/p.png" }]))
    expect(content["m.new_content"]?.body).toBe("[image] https://e.com/p.png")
    expect(content["m.new_content"]?.formatted_body).toBe(
      '<a href="https://e.com/p.png">[image]</a>'
    )
    expect(content.body).toBe("* [image] https://e.com/p.png")
  })

  it("keeps text alongside media in an edit", () => {
    const content = serializeEdit(
      "$target",
      req([
        { type: "text", text: "see" },
        { type: "image", url: "https://e.com/p.png" },
      ])
    )
    expect(content["m.new_content"]?.body).toBe("see\n[image] https://e.com/p.png")
  })
})

describe("serializeReaction", () => {
  it("builds an m.annotation relation", () => {
    expect(serializeReaction("$t", "👍")).toEqual({
      eventType: "m.reaction",
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$t", key: "👍" } },
    })
  })
})
