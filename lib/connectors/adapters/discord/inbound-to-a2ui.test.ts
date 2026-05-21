import { discordInboundToA2UI } from "./inbound-to-a2ui"

describe("discordInboundToA2UI", () => {
  it("returns null on an empty payload", () => {
    expect(discordInboundToA2UI({})).toBeNull()
  })

  it("maps content + embed title + description into a card with heading", () => {
    const out = discordInboundToA2UI({
      content: "Hello @here",
      embeds: [{ title: "Release v1.0", description: "Ships tonight" }],
    })
    expect(out!.body).toEqual([
      { kind: "text", text: "Hello @here" },
      {
        kind: "card",
        title: "Release v1.0",
        children: [{ kind: "text", text: "Ships tonight" }],
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
        { kind: "text", text: "Version: 1.0" },
        { kind: "text", text: "Status: Green" },
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
})
