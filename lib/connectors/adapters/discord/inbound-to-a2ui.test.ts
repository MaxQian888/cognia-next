import { discordInboundToA2UI } from "./inbound-to-a2ui"

describe("discordInboundToA2UI", () => {
  it("does not turn a callback-style button without custom_id into a link", () => {
    expect(
      discordInboundToA2UI({
        components: [
          { type: 1, components: [{ type: 2, style: 1, label: "Act", url: "https://x.test" }] },
        ],
      })?.body[0]
    ).toMatchObject({ children: [{ actionId: "" }] })
  })
  it("returns null on an empty payload", () => {
    expect(discordInboundToA2UI({})).toBeNull()
  })

  it("maps content + embed title + description into a card with heading", () => {
    const out = discordInboundToA2UI({
      content: "Hello @here",
      embeds: [{ title: "Release v1.0", description: "Ships tonight" }],
    })
    expect(out!.body).toEqual([
      { kind: "text", text: "Hello @here", format: "markdown" },
      {
        kind: "card",
        title: "Release v1.0",
        children: [{ kind: "text", text: "Ships tonight", format: "markdown" }],
      },
    ])
  })

  it("maps embed fields into a list", () => {
    const out = discordInboundToA2UI({
      embeds: [
        {
          title: "Release",
          fields: [
            { name: "Version", value: "1.0" },
            { name: "Status", value: "Green" },
          ],
        },
      ],
    })
    expect((out!.body[0] as { children: unknown[] }).children).toContainEqual({
      kind: "list",
      children: [
        { kind: "text", text: "Version: 1.0", format: "markdown" },
        { kind: "text", text: "Status: Green", format: "markdown" },
      ],
    })
  })

  it("renders embed image when present (falls back to thumbnail)", () => {
    const out = discordInboundToA2UI({
      embeds: [{ title: "x", image: { url: "https://example.com/a.png" } }],
    })
    expect((out!.body[0] as { children: unknown[] }).children).toContainEqual({
      kind: "image",
      url: "https://example.com/a.png",
    })
  })

  it("maps an ActionRow of buttons including style + custom_id", () => {
    const out = discordInboundToA2UI({
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: "OK", custom_id: "ok" },
            { type: 2, style: 4, label: "Cancel", custom_id: "cancel" },
            { type: 2, style: 5, label: "Docs", url: "https://example.com" },
          ],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "row",
      children: [
        { kind: "button", label: "OK", style: "primary", actionId: "ok" },
        { kind: "button", label: "Cancel", style: "danger", actionId: "cancel" },
        { kind: "button", label: "Docs", style: "default", url: "https://example.com" },
      ],
    })
  })

  it("treats a select menu as a button with the placeholder as label", () => {
    const out = discordInboundToA2UI({
      components: [
        {
          type: 1,
          components: [{ type: 3, custom_id: "menu", placeholder: "Pick a role" }],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "row",
      children: [{ kind: "button", label: "Pick a role", actionId: "menu" }],
    })
  })

  it("preserves the original payload as raw", () => {
    const p = { content: "x", embeds: [] }
    const out = discordInboundToA2UI(p)
    expect(out!.raw).toBe(p)
  })

  it("unwraps the gateway dispatch the parser stores as event.raw", () => {
    const out = discordInboundToA2UI({
      op: 0,
      t: "MESSAGE_CREATE",
      d: {
        content: "hi",
        components: [
          { type: 1, components: [{ type: 2, label: "Docs", url: "https://x.test", style: 5 }] },
        ],
      },
    } as never)
    expect(out?.body).toEqual([
      { kind: "text", text: "hi", format: "markdown" },
      {
        kind: "row",
        children: [
          {
            kind: "button",
            label: "Docs",
            url: "https://x.test",
            actionId: undefined,
            style: "default",
          },
        ],
      },
    ])
    expect(discordInboundToA2UI({ op: 0, t: "MESSAGE_CREATE" } as never)).toBeNull()
  })

  it("keeps mention tokens verbatim and preserves line breaks", () => {
    const out = discordInboundToA2UI({ content: "<@123> in <#456>\nbye", embeds: [{ title: "E" }] })
    expect(out?.body[0]).toEqual({
      kind: "text",
      text: "<@123> in <#456>  \nbye",
      format: "markdown",
    })
  })
})
