/**
 * @jest-environment jsdom
 *
 * Cross-platform smoke that drives every adapter mapper through the
 * shared dispatcher. Treats the dispatcher + per-platform mappers as
 * one functional unit and confirms each Phase 1 platform produces a
 * non-null InboundA2UIBlock for a representative payload.
 *
 * Live network calls and Tauri commands are stubbed by the per-mapper
 * unit tests; this layer only verifies the dispatch wiring is complete
 * end-to-end so a missing import would surface here.
 */

import { projectInboundToA2UI } from "@/lib/connectors/adapters/_shared/inbound-a2ui-dispatch"

describe("inbound-a2ui-pipeline smoke", () => {
  it("slack — block kit reaches the A2UI projection", () => {
    const out = projectInboundToA2UI("slack", {
      blocks: [{ type: "header", text: { type: "plain_text", text: "Hi" } }],
    })
    expect(out).not.toBeNull()
    expect(out!.source).toBe("slack")
    expect(out!.body[0]).toMatchObject({ kind: "heading", text: "Hi" })
  })

  it("lark — interactive card reaches the A2UI projection", () => {
    const out = projectInboundToA2UI("lark", {
      header: { title: { content: "Standup" } },
      elements: [{ tag: "div", text: { content: "Body" } }],
    })
    expect(out).not.toBeNull()
    expect(out!.source).toBe("lark")
  })

  it("discord — embed + ActionRow reach the A2UI projection", () => {
    const out = projectInboundToA2UI("discord", {
      embeds: [{ title: "Release" }],
      components: [
        {
          type: 1,
          components: [{ type: 2, label: "Approve", custom_id: "approve" }],
        },
      ],
    })
    expect(out).not.toBeNull()
    expect(out!.body.find((n) => n.kind === "card")).toBeDefined()
    expect(out!.body.find((n) => n.kind === "row")).toBeDefined()
  })

  it("telegram — inline keyboard reaches the A2UI projection", () => {
    const out = projectInboundToA2UI("telegram", {
      text: "Pick",
      reply_markup: {
        inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]],
      },
    })
    expect(out).not.toBeNull()
    expect(out!.body.find((n) => n.kind === "row")).toBeDefined()
  })

  it("onebot — CQ-code segments reach the A2UI projection", () => {
    const out = projectInboundToA2UI("onebot", {
      message: [
        { type: "text", data: { text: "hi" } },
        { type: "image", data: { url: "https://example.com/a.png" } },
      ],
    })
    expect(out).not.toBeNull()
    expect(out!.body.find((n) => n.kind === "image")).toBeDefined()
  })

  it("returns null cleanly for unsupported platforms", () => {
    expect(projectInboundToA2UI("matrix" as never, { x: 1 })).toBeNull()
  })
})
