import { larkInboundToA2UI } from "./inbound-to-a2ui"

describe("larkInboundToA2UI", () => {
  it("reads Card 2.0 body without requiring a header", () => {
    const card = {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "A complete answer" }] },
    }
    expect(larkInboundToA2UI(card)?.body).toEqual([
      { kind: "text", text: "A complete answer", format: "markdown" },
    ])
  })

  it("preserves nested Card 2.0 forms, panels, buttons and unknown components", () => {
    const chart = { tag: "chart", chart_spec: { type: "bar" } }
    const out = larkInboundToA2UI({
      body: {
        elements: [
          {
            tag: "collapsible_panel",
            header: { title: { tag: "plain_text", content: "Details" } },
            elements: [
              {
                tag: "form",
                elements: [
                  { tag: "markdown", content: "Review this" },
                  {
                    tag: "button",
                    text: { content: "Continue" },
                    type: "primary_filled",
                    behaviors: [{ type: "open_url", default_url: "https://example.com" }],
                  },
                ],
              },
              chart,
            ],
          },
        ],
      },
    })
    expect(out?.body).toEqual([
      {
        kind: "card",
        title: "Details",
        children: [
          {
            kind: "column",
            children: [
              { kind: "text", text: "Review this", format: "markdown" },
              {
                kind: "button",
                label: "Continue",
                url: "https://example.com",
                actionId: undefined,
                style: "primary",
              },
            ],
          },
          { kind: "raw_json", label: "chart", payload: chart },
        ],
      },
    ])
  })

  it("reads localized Card 2.0 content and callback behaviors", () => {
    expect(
      larkInboundToA2UI({
        body: {
          elements: [
            { tag: "markdown", i18n_content: { en_us: "English", zh_cn: "中文" } },
            {
              tag: "button",
              text: { content: "Submit" },
              behaviors: [{ type: "callback", value: { actionId: "form-submit" } }],
            },
          ],
        },
      })?.body
    ).toMatchObject([
      { kind: "text", text: "English" },
      { kind: "button", actionId: "form-submit" },
    ])
  })

  it.each(["null", "[]", "42", '"text"'])("ignores non-object JSON content %s", (content) => {
    expect(
      larkInboundToA2UI({ event: { message: { message_type: "interactive", content } } })
    ).toBeNull()
  })

  it("returns null when payload has no header or elements", () => {
    expect(larkInboundToA2UI({})).toBeNull()
  })

  it("maps header title into a heading + subtitle into muted text", () => {
    const out = larkInboundToA2UI({
      header: { title: { content: "Daily standup" }, subtitle: { content: "2026-05-20" } },
      elements: [],
    })
    expect(out!.body[0]).toEqual({ kind: "heading", level: 2, text: "Daily standup" })
    expect(out!.body[1]).toEqual({
      kind: "text",
      text: "2026-05-20",
      emphasis: "muted",
    })
  })

  it("maps div / markdown / hr elements", () => {
    const out = larkInboundToA2UI({
      elements: [
        { tag: "div", text: { content: "Hello" } },
        { tag: "hr" },
        { tag: "markdown", content: "**bold**" },
      ],
    })
    expect(out!.body).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "divider" },
      { kind: "text", text: "**bold**", format: "markdown" },
    ])
  })

  it("maps an action element with two buttons into a row", () => {
    const out = larkInboundToA2UI({
      elements: [
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { content: "Yes" },
              type: "primary",
              value: { action_id: "yes" },
            },
            { tag: "button", text: { content: "No" }, type: "danger", value: { action_id: "no" } },
          ],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "row",
      children: [
        { kind: "button", label: "Yes", style: "primary", actionId: "yes" },
        { kind: "button", label: "No", style: "danger", actionId: "no" },
      ],
    })
  })

  it("maps column_set into a row of columns", () => {
    const out = larkInboundToA2UI({
      elements: [
        {
          tag: "column_set",
          columns: [
            { elements: [{ tag: "div", text: { content: "L" } }] },
            { elements: [{ tag: "div", text: { content: "R" } }] },
          ],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "row",
      children: [
        { kind: "column", children: [{ kind: "text", text: "L" }] },
        { kind: "column", children: [{ kind: "text", text: "R" }] },
      ],
    })
  })

  it("maps img with img_key to lark-img: URL", () => {
    const out = larkInboundToA2UI({
      elements: [{ tag: "img", img_key: "kkk", alt: { content: "alt" } }],
    })
    expect(out!.body[0]).toEqual({ kind: "image", url: "lark-img:kkk", alt: "alt" })
  })

  it("maps note elements as muted text", () => {
    const out = larkInboundToA2UI({
      elements: [{ tag: "note", text: { content: "footnote" } }],
    })
    expect(out!.body[0]).toEqual({ kind: "text", text: "footnote", emphasis: "muted" })
  })

  it("falls back to i18n_elements.en_us when elements is missing", () => {
    const out = larkInboundToA2UI({
      i18n_elements: { en_us: [{ tag: "div", text: { content: "i18n hello" } }] },
    })
    expect(out!.body).toEqual([{ kind: "text", text: "i18n hello" }])
  })

  it("appends card_link as a link node", () => {
    const out = larkInboundToA2UI({
      elements: [{ tag: "div", text: { content: "Body" } }],
      card_link: { url: "https://example.com" },
    })
    expect(out!.body).toContainEqual({
      kind: "link",
      href: "https://example.com",
      label: "https://example.com",
    })
  })

  it("preserves the original payload under raw", () => {
    const payload = { elements: [{ tag: "div", text: { content: "hi" } }] }
    const out = larkInboundToA2UI(payload)
    expect(out!.raw).toBe(payload)
  })
})

// In production `projectInboundToA2UI` passes `event.raw` — the FULL event
// envelope, whose interactive card is stringified at `event.message.content` —
// NOT a bare card payload. Before the fix the mapper received the envelope and
// always returned null. These guard the unwrap.
describe("larkInboundToA2UI (production event envelope)", () => {
  it("unwraps an interactive card stringified at event.message.content", () => {
    const card = {
      header: { title: { content: "Approval" } },
      elements: [{ tag: "div", text: { content: "Please review" } }],
    }
    const envelope = {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: {
        message: { message_type: "interactive", content: JSON.stringify(card) },
      },
    }
    const out = larkInboundToA2UI(envelope)
    expect(out).not.toBeNull()
    expect(out!.body[0]).toEqual({ kind: "heading", level: 2, text: "Approval" })
    expect(out!.body[1]).toEqual({ kind: "text", text: "Please review" })
  })

  it("returns null for a non-interactive inbound message (text/image)", () => {
    const envelope = {
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: {
        message: { message_type: "text", content: JSON.stringify({ text: "hi" }) },
      },
    }
    expect(larkInboundToA2UI(envelope)).toBeNull()
  })

  it("returns null when the interactive content is malformed JSON", () => {
    const envelope = {
      header: { event_type: "im.message.receive_v1" },
      event: { message: { message_type: "interactive", content: "{not json" } },
    }
    expect(larkInboundToA2UI(envelope)).toBeNull()
  })

  it("returns null when the envelope carries no message", () => {
    const envelope = { header: { event_type: "im.message.message_read_v1" }, event: {} }
    expect(larkInboundToA2UI(envelope)).toBeNull()
  })

  it("converts card Markdown dialect and lark_md div text", () => {
    const out = larkInboundToA2UI({
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "<at id=all></at> **go**\nnow" } },
        { tag: "div", text: { tag: "plain_text", content: "a*b*c" } },
      ],
    })
    expect(out!.body).toEqual([
      { kind: "text", text: "@all **go**  \nnow", format: "markdown" },
      { kind: "text", text: "a*b*c" },
    ])
  })

  it("reads legacy note text from its nested elements", () => {
    const out = larkInboundToA2UI({
      elements: [{ tag: "note", elements: [{ tag: "plain_text", content: "footer" }] }],
    })
    expect(out!.body).toEqual([{ kind: "text", text: "footer", emphasis: "muted" }])
  })

  it("never lets a non-string content value through as text", () => {
    const out = larkInboundToA2UI({
      header: { title: { content: { x: 1 } } },
      elements: [{ tag: "markdown", content: { nested: true } }, { tag: "hr" }],
    } as never)
    expect(out!.title).toBeUndefined()
    expect(out!.body).toEqual([{ kind: "divider" }])
  })

  describe("converted card form (what im.message.receive_v1 delivers)", () => {
    const converted = {
      title: "Deploy prod",
      elements: [
        [
          { tag: "text", text: "Status: " },
          { tag: "a", href: "https://x.test/run(1)", text: "run_1" },
          { tag: "text", text: " by " },
          { tag: "at", user_id: "ou_1", user_name: "Alice" },
        ],
        [{ tag: "img", image_key: "img_v3_x" }],
        [
          { tag: "button", text: "Approve", type: "primary" },
          { tag: "button", text: "Reject", type: "danger" },
        ],
        [{ tag: "hr" }],
        [{ tag: "note", elements: [{ tag: "text", text: "footer" }] }],
        [{ tag: "select_static", options: ["a"], placeholder: "Pick one" }],
        [{ tag: "chart_v9", x: 1 }],
      ],
    }

    it("projects lines, links, mentions, controls and unknown nodes", () => {
      const out = larkInboundToA2UI({
        header: { event_type: "im.message.receive_v1" },
        event: { message: { message_type: "interactive", content: JSON.stringify(converted) } },
      })
      expect(out?.title).toBe("Deploy prod")
      expect(out?.body).toEqual([
        { kind: "heading", level: 2, text: "Deploy prod" },
        {
          kind: "text",
          text: "Status: [run\\_1](https://x.test/run%281%29) by @Alice",
          format: "markdown",
        },
        { kind: "image", url: "lark-img:img_v3_x" },
        {
          kind: "row",
          children: [
            { kind: "button", label: "Approve", style: "primary" },
            { kind: "button", label: "Reject", style: "danger" },
          ],
        },
        { kind: "divider" },
        { kind: "text", text: "footer", format: "markdown", emphasis: "muted" },
        { kind: "button", label: "Pick one" },
        { kind: "raw_json", label: "chart_v9", payload: { tag: "chart_v9", x: 1 } },
      ])
    })

    it("escapes Markdown in plain card text", () => {
      const out = larkInboundToA2UI({
        elements: [[{ tag: "text", text: "# not a heading *nor bold*" }]],
      } as never)
      expect(out?.body).toEqual([
        { kind: "text", text: "\\# not a heading \\*nor bold\\*", format: "markdown" },
      ])
    })
  })
})
