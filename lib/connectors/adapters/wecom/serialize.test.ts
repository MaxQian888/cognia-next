import { serializeSegments, clampUtf8 } from "./serialize"
import type { A2UIMessageSegment, MessageSegment } from "@/types/connectors/segment"

describe("serializeSegments", () => {
  it("joins text + markdown segments into one markdown body", () => {
    const out = serializeSegments([
      { type: "text", text: "Hello" },
      { type: "markdown", md: "**world**" },
    ])
    expect(out.markdown).toBe("Hello\n\n**world**")
    expect(out.a2uiSurfaces).toEqual([])
    expect(out.media).toEqual([])
  })

  it("collects A2UI surfaces and folds their plainTextMirror into the body", () => {
    const surface: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "sfc1",
      content: { components: {}, dataModel: {}, rootId: "root" },
      plainTextMirror: "Approve? [Yes] [No]",
    }
    const out = serializeSegments([{ type: "text", text: "Decision:" }, surface])
    expect(out.a2uiSurfaces).toHaveLength(1)
    expect(out.a2uiSurfaces[0].surfaceId).toBe("sfc1")
    expect(out.markdown).toContain("Decision:")
    expect(out.markdown).toContain("Approve? [Yes] [No]")
  })

  it("renders code segments as fenced blocks", () => {
    const out = serializeSegments([{ type: "code", language: "ts", code: "const x = 1" }])
    expect(out.markdown).toBe("```ts\nconst x = 1\n```")
  })

  it("collects media segments separately from the markdown body", () => {
    const segs: MessageSegment[] = [
      { type: "image", url: "https://cdn/i" },
      {
        type: "file",
        url: "https://cdn/f",
        name: "a.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      },
    ]
    const out = serializeSegments(segs)
    expect(out.media).toEqual([
      { type: "image", url: "https://cdn/i" },
      { type: "file", url: "https://cdn/f", name: "a.pdf", mimeType: "application/pdf" },
    ])
    expect(out.markdown).toBe("")
  })

  it("downgrades opaque platform cards to a text marker", () => {
    const out = serializeSegments([{ type: "card", card: { kind: "x", payload: {} } }])
    expect(out.markdown).toBe("[card]")
    expect(out.cards).toEqual([])
    expect(out.downgrades).toEqual([{ from: "card", to: "text", reason: "wecom_no_generic_card" }])
  })

  it("passes template_card-shaped card payloads through natively", () => {
    const payload = {
      card_type: "button_interaction",
      main_title: { title: "T" },
      button_list: [{ key: "k", text: "Go" }],
    }
    const out = serializeSegments([
      { type: "card", card: { kind: "wecom.template_card", payload } },
    ])
    expect(out.cards).toEqual([payload])
    expect(out.markdown).toBe("")
    expect(out.downgrades).toEqual([])
  })

  it("renders a card payload's text alternative when it is not template_card-shaped", () => {
    const out = serializeSegments([
      { type: "card", card: { kind: "other", payload: { text: "fallback body" } } },
    ])
    expect(out.cards).toEqual([])
    expect(out.markdown).toBe("fallback body")
    expect(out.downgrades).toEqual([
      { from: "card", to: "text", reason: "wecom_card_text_alternative" },
    ])
  })

  it("projects mention / reply / location / poll into text", () => {
    const out = serializeSegments([
      { type: "mention", userId: "u1", displayName: "Bob" },
      { type: "reply", messageId: "m", snippet: "prev" },
    ])
    expect(out.markdown).toContain("@Bob")
    expect(out.markdown).toContain("> prev")
  })
})

describe("clampUtf8", () => {
  it("returns the input unchanged when within the limit", () => {
    expect(clampUtf8("hello", 100)).toBe("hello")
  })

  it("truncates on a code-point boundary when over the byte limit", () => {
    const s = "你好世界" // 4 chars × 3 bytes = 12 bytes
    const out = clampUtf8(s, 6) // room for 2 chars
    expect(out).toBe("你好")
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(6)
  })
})
