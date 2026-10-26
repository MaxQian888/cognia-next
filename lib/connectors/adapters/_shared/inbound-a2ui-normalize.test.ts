import {
  MAX_INBOUND_A2UI_DEPTH,
  displayKey,
  inboundA2UIBlockCoversParts,
  inboundA2UIBlockToPlainText,
  isDisplayableInboundMediaUrl,
  isNavigableInboundUrl,
  isTextOnlyInboundA2UIBlock,
  sanitizeInboundA2UIBlock,
} from "./inbound-a2ui-normalize"
import type { InboundA2UIBlock, InboundA2UINode } from "./inbound-a2ui-types"

describe("sanitizeInboundA2UIBlock", () => {
  it("keeps a well-formed block unchanged", () => {
    const block: InboundA2UIBlock = {
      v: 1,
      source: "lark",
      title: "Deploy",
      body: [
        { kind: "heading", level: 2, text: "Deploy" },
        { kind: "text", text: "**done**", format: "markdown" },
        { kind: "row", children: [{ kind: "button", label: "Open", url: "https://x.test" }] },
      ],
      raw: { any: "thing" },
    }
    expect(sanitizeInboundA2UIBlock(block)).toEqual(block)
  })

  it("rejects non-objects, unknown sources and empty bodies", () => {
    expect(sanitizeInboundA2UIBlock(null)).toBeNull()
    expect(sanitizeInboundA2UIBlock("x")).toBeNull()
    expect(
      sanitizeInboundA2UIBlock({ v: 1, source: "irc", body: [{ kind: "divider" }] })
    ).toBeNull()
    expect(sanitizeInboundA2UIBlock({ v: 1, source: "slack" })).toBeNull()
    expect(sanitizeInboundA2UIBlock({ v: 1, source: "slack", body: "nope" })).toBeNull()
    expect(sanitizeInboundA2UIBlock({ v: 1, source: "slack", body: [null, 3] })).toBeNull()
  })

  it("drops malformed nodes instead of letting them reach React", () => {
    const block = sanitizeInboundA2UIBlock({
      v: 1,
      source: "lark",
      body: [
        null,
        { kind: "text", text: { nested: "object" } },
        { kind: "text", text: "kept", emphasis: "shouting", format: "html" },
        { kind: "row", children: "not-an-array" },
        { kind: "image" },
        { kind: "link", href: 42 },
        { kind: "heading", level: 9, text: "H" },
        { kind: "alert", tone: "nuclear", children: [{ kind: "text", text: "a" }] },
        { kind: "button", label: { x: 1 }, url: 5, style: "neon" },
        { kind: "mystery" },
      ],
    })
    expect(block?.body).toEqual([
      { kind: "text", text: "kept" },
      { kind: "row", children: [] },
      { kind: "heading", level: 2, text: "H" },
      { kind: "alert", tone: "info", children: [{ kind: "text", text: "a" }] },
      { kind: "button", label: "" },
    ])
  })

  it("bounds nesting depth", () => {
    let node: InboundA2UINode = { kind: "text", text: "deep" }
    for (let i = 0; i < MAX_INBOUND_A2UI_DEPTH + 5; i++) node = { kind: "column", children: [node] }
    const block = sanitizeInboundA2UIBlock({ v: 1, source: "slack", body: [node] })
    expect(JSON.stringify(block)).not.toContain("deep")
  })
})

describe("isTextOnlyInboundA2UIBlock", () => {
  it("is true only when every top-level node is text", () => {
    expect(
      isTextOnlyInboundA2UIBlock({ v: 1, source: "onebot", body: [{ kind: "text", text: "hi" }] })
    ).toBe(true)
    expect(
      isTextOnlyInboundA2UIBlock({
        v: 1,
        source: "onebot",
        body: [
          { kind: "text", text: "hi" },
          { kind: "image", url: "https://x.test/a.png" },
        ],
      })
    ).toBe(false)
  })
})

describe("inboundA2UIBlockToPlainText", () => {
  it("flattens prose, links, mentions, lists and button labels", () => {
    const text = inboundA2UIBlockToPlainText({
      v: 1,
      source: "discord",
      body: [
        { kind: "heading", level: 2, text: "Release" },
        {
          kind: "card",
          title: "v2",
          subtitle: "notes",
          children: [
            { kind: "list", children: [{ kind: "text", text: "one" }] },
            { kind: "link", href: "https://x.test", label: "docs" },
            { kind: "link", href: "https://y.test", label: "https://y.test" },
          ],
        },
        { kind: "mention", handle: "U1", resolved: "alice" },
        { kind: "row", children: [{ kind: "button", label: "Approve", actionId: "a" }] },
        { kind: "image", url: "https://x.test/p.png" },
        { kind: "raw_json", payload: { secret: true } },
      ],
    })
    expect(text).toBe(
      [
        "Release",
        "v2",
        "notes",
        "- one",
        "docs (https://x.test)",
        "https://y.test",
        "@alice",
        "[Approve]",
      ].join("\n")
    )
  })
})

describe("inboundA2UIBlockCoversParts", () => {
  const block: InboundA2UIBlock = {
    v: 1,
    source: "matrix",
    body: [
      { kind: "text", text: "hello   there" },
      { kind: "image", url: "https://x.test/p.png" },
    ],
  }

  it("is covered when every text part appears in the block", () => {
    expect(
      inboundA2UIBlockCoversParts(block, [
        { type: "text", text: "hello there" },
        { type: "text", text: "[image: https://x.test/p.png]" },
      ])
    ).toBe(true)
  })

  it("is not covered when a part carries text the block lacks", () => {
    expect(inboundA2UIBlockCoversParts(block, [{ type: "text", text: "something else" }])).toBe(
      false
    )
  })

  it("needs the marker's own image, not any image of the block", () => {
    // Discord: an attachment marker next to an embed's picture.
    expect(
      inboundA2UIBlockCoversParts(block, [
        { type: "text", text: "hello there [image: https://cdn.test/private.png]" },
      ])
    ).toBe(false)
  })

  it("compares displayed text, not Markdown source", () => {
    const slack: InboundA2UIBlock = {
      v: 1,
      source: "slack",
      body: [
        {
          kind: "text",
          text: "**Deploy** done for [prod](https://x.test) a\\_b",
          format: "markdown",
        },
        { kind: "divider" },
      ],
    }
    expect(
      inboundA2UIBlockCoversParts(slack, [{ type: "text", text: "Deploy done for prod a_b" }])
    ).toBe(true)
  })

  it("covers a file marker only with a link of the same name, not any link", () => {
    const embed: InboundA2UIBlock = {
      v: 1,
      source: "discord",
      body: [
        { kind: "text", text: "see docs" },
        {
          kind: "card",
          title: "Docs",
          children: [{ kind: "link", href: "https://d.test", label: "https://d.test" }],
        },
      ],
    }
    const parts = [
      { type: "text", text: "[file: report.pdf]" },
      { type: "text", text: "see docs" },
    ]
    expect(inboundA2UIBlockCoversParts(embed, parts)).toBe(false)
    const withAttachment: InboundA2UIBlock = {
      ...embed,
      body: [...embed.body, { kind: "link", href: "https://x.test/r.pdf", label: "report.pdf" }],
    }
    expect(inboundA2UIBlockCoversParts(withAttachment, parts)).toBe(true)
  })

  it("does not treat different punctuation as the same text", () => {
    const plain: InboundA2UIBlock = {
      v: 1,
      source: "slack",
      body: [{ kind: "text", text: "ratelimit" }, { kind: "divider" }],
    }
    expect(inboundA2UIBlockCoversParts(plain, [{ type: "text", text: "rate_limit" }])).toBe(false)
    const approx: InboundA2UIBlock = { ...plain, body: [{ kind: "text", text: "100 USD" }] }
    expect(inboundA2UIBlockCoversParts(approx, [{ type: "text", text: "~100 USD" }])).toBe(false)
  })

  it("keeps media markers visible when the block has no media node", () => {
    const textOnly: InboundA2UIBlock = {
      v: 1,
      source: "wecom",
      body: [{ kind: "text", text: "a" }],
    }
    expect(inboundA2UIBlockCoversParts(textOnly, [{ type: "text", text: "[image: k]" }])).toBe(
      false
    )
  })

  it("is not covered by non-text parts", () => {
    expect(inboundA2UIBlockCoversParts(block, [{ type: "file", url: "x" }])).toBe(false)
  })
})

describe("url predicates", () => {
  it.each([
    ["https://x.test/a.png", true],
    ["http://x.test/a.png", true],
    ["data:image/png;base64,AAAA", true],
    ["blob:https://app/1", true],
    ["lark-img:img_v2_x", false],
    ["telegram-file:AgAD", false],
    ["mxc://server/id", false],
    ["data:text/html,<script>", false],
  ])("isDisplayableInboundMediaUrl(%s) = %s", (url, expected) => {
    expect(isDisplayableInboundMediaUrl(url)).toBe(expected)
  })

  it.each([
    ["https://x.test", true],
    ["mailto:a@b.test", true],
    ["javascript:alert(1)", false],
    ["telegram-file:AgAD", false],
  ])("isNavigableInboundUrl(%s) = %s", (url, expected) => {
    expect(isNavigableInboundUrl(url)).toBe(expected)
  })
})

describe("displayKey", () => {
  it("reduces Markdown, escapes and entities to the displayed text", () => {
    expect(displayKey("**a**  [b](https://x.test)\n\\*c\\* &amp; ~~d~~ `e`")).toBe("a b *c* & d e")
  })

  it("keeps lone and intra-word markers, which CommonMark shows as text", () => {
    expect(displayKey("rate_limit ~100 USD 2*3*4 snake_case_name")).toBe(
      "rate_limit ~100 USD 2*3*4 snake_case_name"
    )
    expect(displayKey("_it_ and *em*")).toBe("it and em")
  })
})

describe("inboundA2UIBlockToPlainText in Markdown mode", () => {
  it("escapes plain text, keeps Markdown text and writes links as links", () => {
    expect(
      inboundA2UIBlockToPlainText(
        {
          v: 1,
          source: "lark",
          body: [
            { kind: "heading", level: 2, text: "[image: x] <b>" },
            { kind: "text", text: "**kept**", format: "markdown" },
            { kind: "link", href: "https://x.test/a(1)", label: "doc" },
            { kind: "row", children: [{ kind: "button", label: "Go" }] },
          ],
        },
        { markdown: true }
      )
    ).toBe(
      ["\\[image: x\\] \\<b\\>", "**kept**", "[doc](https://x.test/a%281%29)", "\\[Go\\]"].join(
        "\n"
      )
    )
  })
})
