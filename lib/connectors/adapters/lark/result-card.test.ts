/**
 * Tests for lib/connectors/adapters/lark/result-card.ts — the Card 2.0
 * "result card" for completed ai-run answers.
 */

import {
  buildLarkResultCard,
  buildLarkResultCardSegment,
  withLarkResultCard,
  type LarkResultCardInput,
} from "./result-card"
import type { MessageSegment } from "@/types/connectors/segment"

type CardElement = Record<string, unknown>

function elements(card: Record<string, unknown>): CardElement[] {
  return (card.body as { elements: CardElement[] }).elements
}

function markdownTexts(card: Record<string, unknown>): string[] {
  return elements(card)
    .filter((el) => el.tag === "markdown")
    .map((el) => String(el.content))
}

const BASE: LarkResultCardInput = { answer: "All done.", status: "done" }

describe("buildLarkResultCard — card shape", () => {
  it("emits schema 2.0 with update_multi + answer summary", () => {
    const card = buildLarkResultCard(BASE)
    expect(card.schema).toBe("2.0")
    const config = card.config as Record<string, unknown>
    expect(config.update_multi).toBe(true)
    expect((config.summary as { content: string }).content).toBe("All done.")
    expect(config.width_mode).toBeUndefined()
  })

  it("omits the header for the terminal done card", () => {
    expect(buildLarkResultCard(BASE).header).toBeUndefined()
  })

  it("error status gets a red header", () => {
    const card = buildLarkResultCard({ ...BASE, status: "error" })
    const header = card.header as Record<string, unknown>
    expect(header.template).toBe("red")
    expect((header.title as { content: string }).content).toBe("出错了 / Something went wrong")
  })

  it("interrupted status gets an orange header, compact width, and the 🛑 status line", () => {
    const card = buildLarkResultCard({ ...BASE, status: "interrupted" })
    const header = card.header as Record<string, unknown>
    expect(header.template).toBe("orange")
    expect((header.title as { content: string }).content).toBe("任务已停止 / Stopped")
    const config = card.config as Record<string, unknown>
    expect(config.width_mode).toBe("compact")
    const els = elements(card)
    const stopped = els.find((el) => el.element_id === "interrupted_status")
    expect(stopped).toMatchObject({
      tag: "markdown",
      content: "🛑 **任务已停止 / Stopped**",
      text_size: "notation",
    })
    // The 🛑 line is prepended before the answer element.
    expect(els.indexOf(stopped!)).toBeLessThan(els.findIndex((el) => el.element_id === "answer"))
  })

  it("falls back to a bilingual summary title when the answer is empty", () => {
    const card = buildLarkResultCard({ answer: "   ", status: "done" })
    const config = card.config as Record<string, unknown>
    expect((config.summary as { content: string }).content).toBe("回复 / Reply")
    // An empty answer still yields a body element rather than a bare footer.
    expect(elements(card).some((el) => el.element_id === "answer")).toBe(true)
  })

  it("uses the literal first 60 answer characters as the summary", () => {
    const card = buildLarkResultCard({
      answer: "See ![architecture diagram](https://cdn.example.com/a.png) for details",
      status: "done",
    })
    const config = card.config as Record<string, unknown>
    expect((config.summary as { content: string }).content).toBe(
      "See ![architecture diagram](https://cdn.example.com/a.png) for".slice(0, 60)
    )
    // Exactly 60 chars for a long answer.
    const long = buildLarkResultCard({ answer: "x".repeat(100), status: "done" })
    expect(((long.config as Record<string, unknown>).summary as { content: string }).content).toBe(
      "x".repeat(60)
    )
  })
})

describe("buildLarkResultCard — quote element", () => {
  it("renders the quote as a `> 回复：` blockquote before the answer", () => {
    const card = buildLarkResultCard({ ...BASE, quote: "ship it" })
    const quote = elements(card).find((el) => el.element_id === "quote")
    expect(quote).toMatchObject({ tag: "markdown", content: "> 回复：ship it" })
    expect(elements(card).indexOf(quote!)).toBe(0)
  })

  it("collapses whitespace to one line and clamps at 120 chars", () => {
    const card = buildLarkResultCard({ ...BASE, quote: "line one\n\n  line   two\ta" })
    const quote = elements(card).find((el) => el.element_id === "quote")
    expect(quote!.content).toBe("> 回复：line one line two a")

    const long = buildLarkResultCard({ ...BASE, quote: "x".repeat(200) })
    const longQuote = elements(long).find((el) => el.element_id === "quote")!
    const quotedText = String(longQuote.content).replace("> 回复：", "")
    expect(quotedText.length).toBe(120)
    expect(quotedText.endsWith("…")).toBe(true)
  })

  it("escapes <, > and & so quoted text cannot mint a mention or break out", () => {
    const card = buildLarkResultCard({ ...BASE, quote: "hey <at id=ou_evil></at> & <b>" })
    const quote = elements(card).find((el) => el.element_id === "quote")!
    expect(quote.content).toBe("> 回复：hey &lt;at id=ou_evil&gt;&lt;/at&gt; &amp; &lt;b&gt;")
    expect(String(quote.content)).not.toContain("<at")
  })

  it("omits the quote element entirely when quote is missing or blank", () => {
    expect(elements(buildLarkResultCard(BASE)).some((el) => el.element_id === "quote")).toBe(false)
    expect(
      elements(buildLarkResultCard({ ...BASE, quote: "   " })).some(
        (el) => el.element_id === "quote"
      )
    ).toBe(false)
  })
})

describe("buildLarkResultCard — answer splitting", () => {
  it("keeps a short answer in a single `answer` markdown element", () => {
    const card = buildLarkResultCard(BASE)
    const answers = elements(card).filter((el) => String(el.element_id).startsWith("answer"))
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({
      tag: "markdown",
      element_id: "answer",
      content: "All done.",
    })
  })

  it("splits long answers at blank-line boundaries, each element ≤3000 chars", () => {
    const para = "p".repeat(2000)
    const card = buildLarkResultCard({ answer: `${para}\n\n${para}\n\n${para}`, status: "done" })
    const answers = elements(card).filter(
      (el) => el.tag === "markdown" && String(el.element_id).startsWith("answer")
    )
    expect(answers.length).toBeGreaterThan(1)
    for (const el of answers) {
      expect(String(el.content).length).toBeLessThanOrEqual(3000)
    }
    // Packed greedily: 2000+2000 doesn't fit, so each paragraph lands alone.
    expect(answers.map((el) => String(el.content))).toEqual([para, para, para])
    expect(answers.map((el) => el.element_id)).toEqual(["answer", "answer_1", "answer_2"])
  })

  it("hard-cuts an unbreakable oversized line as a last resort", () => {
    const card = buildLarkResultCard({ answer: "x".repeat(6500), status: "done" })
    const answers = elements(card).filter(
      (el) => el.tag === "markdown" && String(el.element_id).startsWith("answer")
    )
    expect(answers.map((el) => String(el.content).length)).toEqual([3000, 3000, 500])
  })
})

describe("buildLarkResultCard — image extraction", () => {
  it("emits an img element with the raw URL as img_key placeholder, in place", () => {
    const card = buildLarkResultCard({
      answer: "before\n\n![diagram](https://cdn.example.com/d.png)\n\nafter",
      status: "done",
    })
    const els = elements(card)
    const imgIndex = els.findIndex((el) => el.tag === "img")
    expect(imgIndex).toBeGreaterThan(0)
    expect(els[imgIndex]).toMatchObject({
      tag: "img",
      element_id: "answer_img_0",
      img_key: "https://cdn.example.com/d.png",
      alt: { tag: "plain_text", content: "diagram" },
    })
    // Text either side stays markdown, in order (content is verbatim —
    // surrounding blank lines ride along inside the element).
    expect(String(els[imgIndex - 1].content).trim()).toBe("before")
    expect(String(els[imgIndex + 1].content).trim()).toBe("after")
  })

  it("handles data: URLs and file-path sources as img placeholders", () => {
    const card = buildLarkResultCard({
      answer:
        "![inline](data:image/png;base64,AQID) and ![local](/tmp/shot.png) and ![rel](./out.webp) and ![home](~/pic.jpg) and ![bare](chart.gif)",
      status: "done",
    })
    const imgs = elements(card).filter((el) => el.tag === "img")
    expect(imgs.map((el) => el.img_key)).toEqual([
      "data:image/png;base64,AQID",
      "/tmp/shot.png",
      "./out.webp",
      "~/pic.jpg",
      "chart.gif",
    ])
    expect(imgs.map((el) => el.element_id)).toEqual([
      "answer_img_0",
      "answer_img_1",
      "answer_img_2",
      "answer_img_3",
      "answer_img_4",
    ])
  })

  it("leaves non-qualifying spans as literal markdown", () => {
    const card = buildLarkResultCard({
      answer:
        "![f](mailto:a@b.c) ![t](not-an-image) ![w](ftp://x/y.md) ![](https://ok.example.com/i.png)",
      status: "done",
    })
    const imgs = elements(card).filter((el) => el.tag === "img")
    expect(imgs).toHaveLength(1)
    expect(imgs[0].img_key).toBe("https://ok.example.com/i.png")
    // Default alt text when the span has none.
    expect((imgs[0].alt as { content: string }).content).toBe("image")
    const md = markdownTexts(card).join("\n")
    expect(md).toContain("![f](mailto:a@b.c)")
    expect(md).toContain("![t](not-an-image)")
    expect(md).toContain("![w](ftp://x/y.md)")
  })
})

describe("buildLarkResultCard — footer", () => {
  const footerContent = (card: Record<string, unknown>): string | undefined => {
    const note = elements(card).find((el) => el.tag === "note")
    if (!note) return undefined
    const inner = (note.elements as { content: string }[])[0]
    return inner.content
  }

  it("omits the footer entirely when there is nothing to say", () => {
    const card = buildLarkResultCard(BASE)
    expect(elements(card).some((el) => el.tag === "hr" || el.tag === "note")).toBe(false)
  })

  it("joins at + details + elapsed with ` · `, after an hr", () => {
    const card = buildLarkResultCard({
      ...BASE,
      initiatorOpenId: "ou_abc123",
      detailsUrl: "https://app.example.com/agent-runs?run=r1",
      elapsedMs: 4230,
    })
    const els = elements(card)
    const noteIndex = els.findIndex((el) => el.tag === "note")
    expect(els[noteIndex - 1].tag).toBe("hr")
    expect(footerContent(card)).toBe(
      "<at id=ou_abc123></at> · [查看详情 / Details](https://app.example.com/agent-runs?run=r1) · 耗时 4.2s / elapsed"
    )
    expect((els[noteIndex] as { element_id?: string }).element_id).toBe("footer")
  })

  it.each([
    ["bad-id", undefined],
    ["ou_valid9", "<at id=ou_valid9></at>"],
  ])("gates the at-mention on the open_id shape (%s)", (openId, expected) => {
    const card = buildLarkResultCard({ ...BASE, initiatorOpenId: openId, elapsedMs: 1 })
    const content = footerContent(card)!
    if (expected) expect(content).toContain(expected)
    else expect(content).not.toContain("<at")
  })

  it("drops a non-http(s) details link", () => {
    const card = buildLarkResultCard({
      ...BASE,
      detailsUrl: "javascript:alert(1)",
      elapsedMs: 500,
    })
    const content = footerContent(card)!
    expect(content).not.toContain("javascript:")
    expect(content).toBe("耗时 0.5s / elapsed")
  })

  it("appends the red interrupted marker only for interrupted status", () => {
    const interrupted = buildLarkResultCard({ ...BASE, status: "interrupted" })
    expect(footerContent(interrupted)).toBe("<font color='red'>已被用户中断 / Interrupted</font>")
    const done = buildLarkResultCard({ ...BASE, elapsedMs: 100 })
    expect(footerContent(done)).not.toContain("Interrupted")
  })
})

describe("buildLarkResultCard — mention neutralisation", () => {
  it("defuses <at in the answer with a zero-width space, nothing else escaped", () => {
    const card = buildLarkResultCard({
      answer: "ping <at id=ou_everyone></at> and **bold** stays",
      status: "done",
    })
    const md = markdownTexts(card).join("\n")
    expect(md).not.toContain("<at ")
    expect(md).toContain("<\u200Bat id=ou_everyone></at>")
    expect(md).toContain("**bold** stays")
  })
})

describe("buildLarkResultCardSegment / withLarkResultCard", () => {
  it("wraps the payload as a lark card segment", () => {
    const seg = buildLarkResultCardSegment(BASE)
    expect(seg.type).toBe("card")
    if (seg.type !== "card") return
    expect(seg.card.kind).toBe("lark")
    expect((seg.card.payload as Record<string, unknown>).schema).toBe("2.0")
  })

  it("replaces the LAST markdown segment in place, leaving leading segments", () => {
    const a2ui: MessageSegment = {
      type: "a2ui",
      surfaceId: "s1",
      content: { components: {}, dataModel: {}, rootId: "root" },
      plainTextMirror: "surface",
    }
    const segments: MessageSegment[] = [
      a2ui,
      { type: "markdown", md: "first half" },
      { type: "markdown", md: "final answer" },
    ]
    const out = withLarkResultCard(segments, { status: "done", quote: "q" })
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(a2ui)
    expect(out[1]).toEqual({ type: "markdown", md: "first half" })
    const card = out[2]
    expect(card.type).toBe("card")
    if (card.type !== "card") return
    const md = markdownTexts(card.card.payload as Record<string, unknown>)
    expect(md).toContain("final answer")
    expect(md).not.toContain("first half")
    // Input array is not mutated.
    expect(segments[2]).toEqual({ type: "markdown", md: "final answer" })
  })

  it("converts a trailing text segment into the card answer", () => {
    const out = withLarkResultCard([{ type: "text", text: "plain reply" }], { status: "done" })
    expect(out).toHaveLength(1)
    const card = out[0]
    if (card.type !== "card") throw new Error("expected card")
    expect(markdownTexts(card.card.payload as Record<string, unknown>)).toContain("plain reply")
  })

  it("appends the card from fallbackAnswer when no text segment exists", () => {
    const a2ui: MessageSegment = {
      type: "a2ui",
      surfaceId: "s1",
      content: { components: {}, dataModel: {}, rootId: "root" },
      plainTextMirror: "surface",
    }
    const out = withLarkResultCard([a2ui], { status: "done", fallbackAnswer: "recovered" })
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(a2ui)
    expect(out[1].type).toBe("card")
  })

  it("returns the list unchanged when there is nothing to wrap", () => {
    const segments: MessageSegment[] = [{ type: "image", url: "img_v3_x" }]
    expect(withLarkResultCard(segments, { status: "done" })).toBe(segments)
    expect(withLarkResultCard([], { status: "done" })).toEqual([])
  })
})
