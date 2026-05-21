import { larkInboundToA2UI } from "./inbound-to-a2ui"

describe("larkInboundToA2UI", () => {
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
      { kind: "text", text: "**bold**" },
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
