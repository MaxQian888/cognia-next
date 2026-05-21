import { slackInboundToA2UI } from "./inbound-to-a2ui"

describe("slackInboundToA2UI", () => {
  it("returns null when payload is empty", () => {
    expect(slackInboundToA2UI({})).toBeNull()
  })

  it("falls back to a text node when no blocks are present", () => {
    const out = slackInboundToA2UI({ text: "hello" })
    expect(out).not.toBeNull()
    expect(out!.body).toEqual([{ kind: "text", text: "hello" }])
  })

  it("maps a header block to heading level 2", () => {
    const out = slackInboundToA2UI({
      blocks: [{ type: "header", text: { type: "plain_text", text: "Hi" } }],
    })
    expect(out!.body).toEqual([{ kind: "heading", level: 2, text: "Hi" }])
  })

  it("maps a section with fields into a column containing text + list", () => {
    const out = slackInboundToA2UI({
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Overview" },
          fields: [
            { type: "mrkdwn", text: "*Owner*\nAlice" },
            { type: "mrkdwn", text: "*Status*\nGreen" },
          ],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "column",
      children: [{ kind: "text", text: "Overview" }, { kind: "list" }],
    })
  })

  it("maps an actions block into a row of buttons", () => {
    const out = slackInboundToA2UI({
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              action_id: "approve",
              style: "primary",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              action_id: "deny",
              style: "danger",
            },
          ],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "row",
      children: [
        { kind: "button", label: "Approve", style: "primary", actionId: "approve" },
        { kind: "button", label: "Deny", style: "danger", actionId: "deny" },
      ],
    })
  })

  it("maps an image block", () => {
    const out = slackInboundToA2UI({
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "alt" }],
    })
    expect(out!.body).toEqual([{ kind: "image", url: "https://example.com/a.png", alt: "alt" }])
  })

  it("preserves original blocks under raw", () => {
    const blocks = [{ type: "divider" }]
    const out = slackInboundToA2UI({ blocks })
    expect(out!.raw).toBe(blocks)
  })

  it("ignores unknown block types but keeps known ones around them", () => {
    const out = slackInboundToA2UI({
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Top" } },
        { type: "video", title: { type: "plain_text", text: "??" } } as never,
        { type: "divider" },
      ],
    })
    expect(out!.body).toEqual([{ kind: "heading", level: 2, text: "Top" }, { kind: "divider" }])
  })

  it("maps a context block to a muted row", () => {
    const out = slackInboundToA2UI({
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "Last updated 5m ago" } as never],
        },
      ],
    })
    expect(out!.body[0]).toMatchObject({
      kind: "row",
      children: [{ kind: "text", text: "Last updated 5m ago", emphasis: "muted" }],
    })
  })
})
