import {
  MAX_INBOUND_A2UI_DEPTH,
  displayKey,
  inboundA2UIBlockCoversParts,
  inboundA2UIBlockToPlainText,
  isDisplayableInboundMediaUrl,
  isNavigableInboundUrl,
  isTextOnlyInboundA2UIBlock,
  sanitizeInboundA2UIBlock,
  withInboundDisplayMedia,
} from "./inbound-a2ui-normalize"
import type { InboundA2UIBlock, InboundA2UINode } from "./inbound-a2ui-types"

describe("display-only inbound media", () => {
  it("isolates malformed recognition data while preserving valid neighboring prose", () => {
    expect(() =>
      withInboundDisplayMedia(
        { v: 1, source: "wechat-oa", body: [{ kind: "text", text: "kept" }] },
        "wechat-oa",
        [{ type: "voice", url: "opaque", transcript: {} }] as never
      )
    ).not.toThrow()
  })
  it("preserves each resolved occurrence of the same personal WeChat image reference", () => {
    const block = withInboundDisplayMedia(
      {
        v: 1,
        source: "wechat-personal",
        body: [1, 2].map(() => ({ kind: "image", url: "wechat-personal-media:ref" })),
      },
      "wechat-personal",
      ["AAAA", "BBBB"].map((dataBase64) => ({
        type: "image",
        url: "ref",
        mimeType: "image/png",
        dataBase64,
      }))
    )!
    expect(block.body.map((node) => (node as { displayUrl?: string }).displayUrl)).toEqual([
      "data:image/png;base64,AAAA",
      "data:image/png;base64,BBBB",
    ])
  })
  it("matches shared media references to the compatible kind", () => {
    const block = withInboundDisplayMedia(
      {
        v: 1,
        source: "wechat-personal",
        body: [
          { kind: "image", url: "wechat-personal-media:ref" },
          { kind: "link", href: "wechat-personal-media:ref", label: "Voice" },
        ],
      },
      "wechat-personal",
      [
        { type: "voice", url: "ref" },
        { type: "image", url: "ref", mimeType: "image/png", dataBase64: "AAAA" },
      ]
    )!
    expect(block.body.map((node) => node.kind)).toEqual(["image", "link"])
    expect(block.body[0]).toMatchObject({ displayUrl: "data:image/png;base64,AAAA" })
  })
  it.each(["wechat-personal", "wechat-oa"] as const)(
    "does not repeat %s recognized speech as an unavailable media link",
    (source) => {
      const block = withInboundDisplayMedia(
        { v: 1, source, body: [{ kind: "text", text: "Recognized speech" }] },
        source,
        [{ type: "voice", url: `${source}:voice:opaque`, transcript: "Recognized speech" }]
      )!
      expect(block.body).toEqual([{ kind: "text", text: "Recognized speech" }])
    }
  )
  it("reuses personal WeChat opaque image references and keeps failed ciphertext unavailable", () => {
    const rawUrl = "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=ref"
    const block: InboundA2UIBlock = {
      v: 1,
      source: "wechat-personal",
      body: [{ kind: "image", url: `wechat-personal-media:${rawUrl}` }],
    }
    const resolved = withInboundDisplayMedia(block, "wechat-personal", [
      { type: "image", url: rawUrl, mimeType: "image/png", dataBase64: "AAAA" },
    ])!
    expect(resolved.body).toHaveLength(1)
    expect(resolved.body[0]).toMatchObject({ displayUrl: "data:image/png;base64,AAAA" })
    const failed = withInboundDisplayMedia(block, "wechat-personal", [
      { type: "image", url: rawUrl },
    ])!
    expect(failed.body).toHaveLength(1)
    expect(failed.body[0]).toMatchObject({ url: `wechat-personal-media:${rawUrl}` })
    expect(
      inboundA2UIBlockCoversParts(failed, [{ type: "text", text: `[image: ${rawUrl}]` }])
    ).toBe(true)
    expect(isDisplayableInboundMediaUrl((failed.body[0] as { url: string }).url)).toBe(false)
  })
  it.each(["file", "voice", "video"] as const)(
    "does not append or expose personal WeChat %s ciphertext as a navigable link",
    (type) => {
      const rawUrl = "https://cdn/encrypted"
      const block = withInboundDisplayMedia(
        {
          v: 1,
          source: "wechat-personal",
          body: [{ kind: "link", href: `wechat-personal-media:${rawUrl}`, label: "Media" }],
        },
        "wechat-personal",
        [{ type, url: rawUrl, name: "file.pdf", mimeType: "application/pdf", sizeBytes: 1 }]
      )!
      expect(block.body).toHaveLength(1)
      expect(block.body[0]).toMatchObject({ kind: "link", href: `wechat-personal-media:${rawUrl}` })
      expect(isNavigableInboundUrl((block.body[0] as { href: string }).href)).toBe(false)
    }
  )
  it("migrates legacy inline URLs to the same bounded display-only field", () => {
    const bytes = "A".repeat(4 * 1024 * 1024)
    const block = sanitizeInboundA2UIBlock({
      source: "matrix",
      body: [
        { kind: "image", url: `data:image/png;base64,${bytes}` },
        { kind: "image", url: `data:image/png;base64,${bytes}` },
        { kind: "image", url: `data:image/png;base64,${bytes.repeat(2)}` },
      ],
    })!
    expect(block.body).toHaveLength(3)
    expect(block.body.every((node) => node.kind === "image" && !node.url.startsWith("data:"))).toBe(
      true
    )
    expect(block.body.filter((node) => "displayUrl" in node)).toHaveLength(1)
    expect(JSON.stringify(block).length).toBeLessThan(7 * 1024 * 1024)
  })
  it("never falls back to a WeCom ciphertext image URL after failure or budget exhaustion", () => {
    const failed = withInboundDisplayMedia(
      { v: 1, source: "wecom", body: [{ kind: "image", url: "https://cdn/failed" }] },
      "wecom",
      [{ type: "image", url: "", rawUrl: "https://cdn/failed" }]
    )!
    expect(failed.body[0]).toMatchObject({ kind: "image", url: "wecom-media:https://cdn/failed" })
    expect(
      inboundA2UIBlockCoversParts(failed, [{ type: "text", text: "[image: https://cdn/failed]" }])
    ).toBe(true)
    const bytes = "A".repeat(4 * 1024 * 1024)
    const block = withInboundDisplayMedia(
      null,
      "wecom",
      ["a", "b"].map((id) => ({
        type: "image",
        url: `data:image/png;base64,${bytes}`,
        rawUrl: `https://cdn/${id}`,
        mimeType: "image/png",
        dataBase64: bytes,
      }))
    )!
    expect(block.body).toHaveLength(2)
    expect(block.body[1]).toMatchObject({ kind: "image", url: "wecom-media:https://cdn/b" })
    expect((block.body[1] as { displayUrl?: string }).displayUrl).toBeUndefined()
  })
  it.each(["file", "voice", "video"] as const)(
    "keeps failed %s decryption references non-navigable",
    (type) => {
      const rawUrl = "https://cdn/encrypted"
      const block = withInboundDisplayMedia(
        { v: 1, source: "wecom", body: [{ kind: "link", href: rawUrl, label: "Attachment" }] },
        "wecom",
        [{ type, url: "", rawUrl, name: "doc.pdf", mimeType: "application/pdf", sizeBytes: 0 }]
      )!
      expect(block.body).toHaveLength(1)
      expect(block.body[0]).toMatchObject({ kind: "link", href: "inbound-media:0" })
    }
  )

  it.each(["voice", "video"] as const)("replaces OneBot legacy %s aliases exactly once", (type) => {
    const prefix = type === "voice" ? "cq-record:" : "cq-video:"
    const block = withInboundDisplayMedia(
      { v: 1, source: "onebot", body: [{ kind: "link", href: `${prefix}id`, label: "Media" }] },
      "onebot",
      [{ type, rawUrl: "id", url: "https://cdn/media" }]
    )!
    expect(block.body).toEqual([{ kind: "link", href: "https://cdn/media", label: "Media" }])
  })
  it("keeps rewritten inline media solely in displayUrl with a stable marker reference", () => {
    const bytes = "A".repeat(4 * 1024 * 1024)
    const segment = {
      type: "image" as const,
      url: `data:image/png;base64,${bytes}`,
      rawUrl: "https://cdn/original",
      mimeType: "image/png",
      dataBase64: bytes,
    }
    const block = withInboundDisplayMedia(
      { v: 1, source: "wecom", body: [{ kind: "image", url: segment.rawUrl }] },
      "wecom",
      [segment]
    )!
    expect(block.body[0]).toMatchObject({
      kind: "image",
      url: `wecom-media:${segment.rawUrl}`,
    })
    expect((block.body[0] as { displayUrl?: string }).displayUrl === segment.url).toBe(true)
    expect(JSON.stringify(block).length).toBeLessThan(7 * 1024 * 1024)
    expect(
      inboundA2UIBlockCoversParts(block, [{ type: "text", text: `[image: ${segment.rawUrl}]` }])
    ).toBe(true)
  })
  it("preserves ordered repeated media references in normalized-only projections", () => {
    const block = withInboundDisplayMedia(null, "onebot", [
      { type: "image", url: "pic", dataBase64: "AAAA", mimeType: "image/png" },
      { type: "text", text: "between" },
      { type: "image", url: "pic", dataBase64: "AAAA", mimeType: "image/png" },
    ])
    expect(block?.body.map((node) => node.kind)).toEqual(["image", "text", "image"])
    expect(block?.body[1]).toEqual({ kind: "text", text: "between" })
  })
  it("reuses a Matrix image already projected from the same inline bytes", () => {
    const block = withInboundDisplayMedia(
      { v: 1, source: "matrix", body: [{ kind: "image", url: "data:image/png;base64,AAAA" }] },
      "matrix",
      [
        {
          type: "image",
          url: "https://matrix.test/image",
          rawUrl: "mxc://host/id",
          mimeType: "image/png",
          dataBase64: "AAAA",
        },
      ]
    )!
    expect(block.body).toHaveLength(1)
    expect(block.body[0]).toMatchObject({
      url: "https://matrix.test/image",
      displayUrl: "data:image/png;base64,AAAA",
    })
  })
  it("bounds serialized output while preserving repeated source occurrences", () => {
    const segment = {
      type: "image" as const,
      url: "key",
      dataBase64: "A".repeat(4 * 1024 * 1024),
      mimeType: "image/png",
    }
    const repeated = withInboundDisplayMedia(
      {
        v: 1,
        source: "lark",
        body: Array.from({ length: 3 }, () => ({ kind: "image", url: "lark-img:key" })),
      },
      "lark",
      [segment]
    )!
    expect(JSON.stringify(repeated).length).toBeLessThan(7 * 1024 * 1024)
    expect(withInboundDisplayMedia(null, "lark", [segment, segment])?.body).toHaveLength(2)
    const oversized = sanitizeInboundA2UIBlock({
      v: 1,
      source: "lark",
      body: [
        {
          kind: "image",
          url: "key",
          displayUrl: `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`,
        },
      ],
    })
    expect(oversized?.body[0]).not.toHaveProperty("displayUrl")
  })
  it("keeps the stable reference for dedup while rendering cached bytes", () => {
    const block = withInboundDisplayMedia(null, "lark", [
      { type: "image", url: "image-key", mimeType: "image/png", dataBase64: "AAAA" },
    ])!
    expect(inboundA2UIBlockCoversParts(block, [{ type: "text", text: "[image: image-key]" }])).toBe(
      true
    )
    expect(sanitizeInboundA2UIBlock(block)?.body[0]).toMatchObject({
      displayUrl: "data:image/png;base64,AAAA",
    })
  })

  it("bounds display bytes and does not inline unsupported MIME types", () => {
    const block = withInboundDisplayMedia(null, "lark", [
      {
        type: "image",
        url: "huge",
        mimeType: "image/png",
        dataBase64: "A".repeat(7 * 1024 * 1024 + 1),
      },
      { type: "image", url: "svg", mimeType: "image/svg+xml", dataBase64: "AAAA" },
    ])!
    expect(block.body).toHaveLength(2)
    expect(block.body.every((node) => !("displayUrl" in node))).toBe(true)
  })

  it("presents a file's existing URL and name without duplicating its marker", () => {
    const block = withInboundDisplayMedia(null, "lark", [
      {
        type: "file",
        url: "https://files.test/report.pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
      },
    ])!
    expect(block.body).toEqual([
      { kind: "link", href: "https://files.test/report.pdf", label: "report.pdf" },
    ])
    expect(inboundA2UIBlockCoversParts(block, [{ type: "text", text: "[file: report.pdf]" }])).toBe(
      true
    )
  })

  it("rejects executable display URLs from persisted metadata", () => {
    const block = sanitizeInboundA2UIBlock({
      v: 1,
      source: "lark",
      body: [{ kind: "image", url: "key", displayUrl: "javascript:alert(1)" }],
    })
    expect(block?.body[0]).not.toHaveProperty("displayUrl")
  })
})

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

  it("covers literal OneBot URLs with Markdown-like underscores", () => {
    const body = 'see https://example.com/__keep__/docs; code const text = "keep a_b * 3";'
    const onebot: InboundA2UIBlock = {
      v: 1,
      source: "onebot",
      body: [
        { kind: "mention", handle: "bot" },
        { kind: "text", text: body },
      ],
    }
    expect(inboundA2UIBlockCoversParts(onebot, [{ type: "text", text: `@bot ${body}` }])).toBe(true)
    expect(inboundA2UIBlockCoversParts(onebot, [{ type: "text", text: `${body} extra` }])).toBe(
      false
    )
  })

  it("covers a leading reply marker only when the same preview is displayed separately", () => {
    const parts = [{ type: "text", text: " [reply:previous answer] hello there" }]
    expect(inboundA2UIBlockCoversParts(block, parts, "previous answer")).toBe(true)
    expect(inboundA2UIBlockCoversParts(block, parts)).toBe(false)
    expect(inboundA2UIBlockCoversParts(block, parts, "another answer")).toBe(false)
  })

  it("retains reply-like prose outside the generated leading marker", () => {
    expect(
      inboundA2UIBlockCoversParts(
        block,
        [{ type: "text", text: "hello there [reply:previous answer]" }],
        "previous answer"
      )
    ).toBe(false)
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
it("contains invalid media URLs and preserves valid current text", () => {
  expect(
    withInboundDisplayMedia(
      { v: 1, source: "wecom", body: [{ kind: "text", text: "kept" }] },
      "wecom",
      [{ type: "image", url: 42 }] as never
    )?.body
  ).toEqual([{ kind: "text", text: "kept" }])
})

it("maps resolved voice and video references without replaying bytes", () => {
  const block: InboundA2UIBlock = {
    v: 1,
    source: "onebot",
    body: [
      { kind: "link", href: "audio-id", label: "Audio" },
      { kind: "link", href: "video-id", label: "Video" },
    ],
  }
  expect(
    withInboundDisplayMedia(block, "onebot", [
      { type: "voice", rawUrl: "audio-id", url: "https://cdn/audio" },
      { type: "video", rawUrl: "video-id", url: "https://cdn/video" },
    ])?.body
  ).toEqual([
    { kind: "link", href: "https://cdn/audio", label: "Audio" },
    { kind: "link", href: "https://cdn/video", label: "Video" },
  ])
})
