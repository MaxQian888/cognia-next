import {
  a2uiToDingTalkMarkdown,
  decodeDingTalkMessageId,
  encodeDingTalkMessageId,
  serializeOutbound,
  serializeRecall,
} from "./serialize"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { A2UISegmentContent } from "@/types/connectors/segment"

function req(segments: OutboundRequest["segments"]): OutboundRequest {
  return {
    conversationRef: { platform: "dingtalk", adapterId: "ad_1" },
    segments,
    metadata: { idempotencyKey: "k1" },
  }
}

const surface = (components: Record<string, unknown>, rootId: string): A2UISegmentContent => ({
  components,
  dataModel: {},
  rootId,
})

describe("serializeOutbound", () => {
  it("uses sampleText for a pure text message", () => {
    const out = serializeOutbound(req([{ type: "text", text: "hi there" }]))
    expect(out).toEqual({ msgKey: "sampleText", msgParam: { content: "hi there" } })
  })

  it("uses sampleMarkdown when any markdown is present and derives a title", () => {
    const out = serializeOutbound(req([{ type: "markdown", md: "# Title\nbody text" }]))
    expect(out!.msgKey).toBe("sampleMarkdown")
    expect(out!.msgParam.text).toContain("# Title")
    expect(out!.msgParam.title).toBe("Title")
  })

  it("renders media segments as markdown links", () => {
    const out = serializeOutbound(req([{ type: "image", url: "https://x/y.png", alt: "pic" }]))
    expect(out!.msgKey).toBe("sampleMarkdown")
    expect(out!.msgParam.text).toContain("[image](https://x/y.png)")
  })

  it("returns null when there is nothing renderable", () => {
    expect(serializeOutbound(req([]))).toBeNull()
    expect(serializeOutbound(req([{ type: "text", text: "   " }]))).toBeNull()
  })

  it("renders mention and emoji segments inline (no markdown promotion)", () => {
    const out = serializeOutbound(
      req([
        { type: "mention", userId: "u1", displayName: "Bob" },
        { type: "emoji", code: ":smile:" },
      ])
    )
    expect(out!.msgKey).toBe("sampleText")
    expect(out!.msgParam.content).toContain("@Bob")
    expect(out!.msgParam.content).toContain(":smile:")
  })

  it("renders code, video, voice and file segments as markdown", () => {
    const out = serializeOutbound(
      req([
        { type: "code", code: "x=1", language: "py" },
        { type: "video", url: "https://v/v.mp4" },
        { type: "voice", url: "https://a/a.mp3" },
        {
          type: "file",
          url: "https://f/f.pdf",
          name: "f.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
      ])
    )
    expect(out!.msgKey).toBe("sampleMarkdown")
    expect(out!.msgParam.text).toContain("```")
    expect(out!.msgParam.text).toContain("[video](https://v/v.mp4)")
    expect(out!.msgParam.text).toContain("[voice](https://a/a.mp3)")
    expect(out!.msgParam.text).toContain("[file](https://f/f.pdf)")
  })

  it("falls back to a default title when markdown has no titleable line", () => {
    const out = serializeOutbound(req([{ type: "markdown", md: "***" }]))
    expect(out!.msgParam.title).toBe("Message")
  })

  it("uses the plain-text mirror when the surface projects to nothing", () => {
    const empty = surface({ root: { id: "root", component: "Spacer" } }, "root")
    const out = serializeOutbound(
      req([{ type: "a2ui", surfaceId: "s", content: empty, plainTextMirror: "mirror text" }])
    )
    expect(out!.msgParam.text).toContain("mirror text")
  })

  it("projects an A2UI surface into markdown", () => {
    const content = surface(
      {
        root: { id: "root", component: "Column", children: ["t", "b"] },
        t: { id: "t", component: "Text", text: "Choose an option" },
        b: { id: "b", component: "Button", text: "Docs", href: "https://docs" },
      },
      "root"
    )
    const out = serializeOutbound(
      req([{ type: "a2ui", surfaceId: "s1", content, plainTextMirror: "Choose an option" }])
    )
    expect(out!.msgKey).toBe("sampleMarkdown")
    expect(out!.msgParam.text).toContain("Choose an option")
    expect(out!.msgParam.text).toContain("[Docs](https://docs)")
  })
})

describe("a2uiToDingTalkMarkdown", () => {
  it("maps Card/Alert/Link/Divider/Image natively", () => {
    const content = surface(
      {
        root: { id: "root", component: "Column", children: ["c", "a", "l", "d", "img"] },
        c: { id: "c", component: "Card", title: "Header", description: "desc" },
        a: { id: "a", component: "Alert", title: "Warn", message: "be careful" },
        l: { id: "l", component: "Link", text: "site", href: "https://e" },
        d: { id: "d", component: "Divider" },
        img: { id: "img", component: "Image", src: "https://i/p.png", alt: "p" },
      },
      "root"
    )
    const md = a2uiToDingTalkMarkdown(content)
    expect(md).toContain("### Header")
    expect(md).toContain("desc")
    expect(md).toContain("> ⚠️ Warn: be careful")
    expect(md).toContain("[site](https://e)")
    expect(md).toContain("---")
    expect(md).toContain("![p](https://i/p.png)")
  })

  it("ignores layout-only and unhandled components, and Card/Alert without text", () => {
    const content = surface(
      {
        root: { id: "root", component: "Row", children: ["c", "a", "chart", "list"] },
        c: { id: "c", component: "Card" },
        a: { id: "a", component: "Alert" },
        chart: { id: "chart", component: "Chart" },
        list: { id: "list", component: "List", children: [] },
      },
      "root"
    )
    // No throw, and nothing spurious emitted for empty Card/Alert/Chart/List/Row.
    const md = a2uiToDingTalkMarkdown(content)
    expect(md).not.toContain("###")
    expect(md).not.toContain("⚠️")
  })

  it("handles Select options, Image without src, Link without href, bare Button", () => {
    const content = surface(
      {
        root: { id: "root", component: "Column", children: ["sel", "img", "lk", "b"] },
        sel: {
          id: "sel",
          component: "Select",
          label: "Pick",
          options: [{ value: "a", label: "Apple" }, { value: "b" }],
        },
        img: { id: "img", component: "Image", alt: "noimg" },
        lk: { id: "lk", component: "Link", text: "plain" },
        b: { id: "b", component: "Button", action: "go" },
      },
      "root"
    )
    const md = a2uiToDingTalkMarkdown(content)
    expect(md).toContain("Pick: Apple")
    expect(md).toContain("Pick: b")
    expect(md).toContain("plain")
    expect(md).toContain("- go")
    expect(md).not.toContain("![")
  })

  it("lists callback-only buttons and inputs under an actions heading", () => {
    const content = surface(
      {
        root: { id: "root", component: "Column", children: ["b", "tf"] },
        b: { id: "b", component: "Button", text: "Approve", action: "approve" },
        tf: { id: "tf", component: "TextField", label: "Name" },
      },
      "root"
    )
    const md = a2uiToDingTalkMarkdown(content)
    expect(md).toContain("操作 / Available actions:")
    expect(md).toContain("- Approve")
    expect(md).toContain("- Name: ___")
  })
})

describe("encodeDingTalkMessageId / decodeDingTalkMessageId / serializeRecall", () => {
  it("round-trips a group id and builds the group recall call", () => {
    const id = encodeDingTalkMessageId({
      scope: "group",
      robotCode: "ding_r1",
      openConversationId: "cid+abc==",
      processQueryKey: "pqk:1/2",
    })
    expect(id).toBe("dt:group:ding_r1:cid%2Babc%3D%3D:pqk%3A1%2F2")
    const decoded = decodeDingTalkMessageId(id)
    expect(decoded).toEqual({
      scope: "group",
      robotCode: "ding_r1",
      openConversationId: "cid+abc==",
      processQueryKey: "pqk:1/2",
    })
    expect(serializeRecall(decoded!)).toEqual({
      path: "/v1.0/robot/groupMessages/recall",
      payload: {
        robotCode: "ding_r1",
        openConversationId: "cid+abc==",
        processQueryKeys: ["pqk:1/2"],
      },
    })
  })

  it("round-trips an oto id and builds the batchRecall call", () => {
    const id = encodeDingTalkMessageId({
      scope: "oto",
      robotCode: "ding_r1",
      processQueryKey: "k9",
    })
    expect(id).toBe("dt:oto:ding_r1:-:k9")
    const decoded = decodeDingTalkMessageId(id)
    expect(decoded).toEqual({ scope: "oto", robotCode: "ding_r1", processQueryKey: "k9" })
    expect(serializeRecall(decoded!)).toEqual({
      path: "/v1.0/robot/otoMessages/batchRecall",
      payload: { robotCode: "ding_r1", processQueryKeys: ["k9"] },
    })
  })

  it("returns null for bare keys, foreign prefixes, unknown scopes and missing parts", () => {
    expect(decodeDingTalkMessageId("k9")).toBeNull()
    expect(decodeDingTalkMessageId("qq:oto:r:-:k")).toBeNull()
    expect(decodeDingTalkMessageId("dt:channel:r:-:k")).toBeNull()
    expect(decodeDingTalkMessageId("dt:oto:r:-")).toBeNull()
    expect(decodeDingTalkMessageId("dt:oto::-:k")).toBeNull()
    expect(decodeDingTalkMessageId("dt:oto:r:-:")).toBeNull()
    expect(decodeDingTalkMessageId("dt:group:r::k")).toBeNull()
  })
})
