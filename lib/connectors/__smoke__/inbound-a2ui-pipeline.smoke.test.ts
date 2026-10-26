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
import { parseSlackEventCallback } from "@/lib/connectors/adapters/slack/parse"
import { parseDiscordDispatch } from "@/lib/connectors/adapters/discord/parse"
import { parseTelegramUpdate } from "@/lib/connectors/adapters/telegram/parse"
import { parseLarkEventEnvelope } from "@/lib/connectors/adapters/lark/parse"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** The bus's own call: the parser's event, exactly as `insertInboundMessage` passes it. */
function project(event: NormalizedInboundEvent | null) {
  expect(event).not.toBeNull()
  return projectInboundToA2UI(event!.platform, event!.raw, event!.segments)
}

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

  // The cases above hand mappers bare messages. Production hands them
  // whatever the parser stored as `event.raw` — these go through the real
  // parsers so an envelope mismatch cannot hide behind a hand-made payload.
  describe("native envelopes through the real parsers", () => {
    it("slack — Events API envelope", () => {
      const out = project(
        parseSlackEventCallback("a1", "UBOT", {
          type: "event_callback",
          team_id: "T1",
          event: {
            type: "message",
            channel: "C1",
            channel_type: "channel",
            user: "U1",
            ts: "1714900000.000100",
            text: "Deploy done",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: "*Deploy* done" } },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Open" },
                    url: "https://x.test",
                  },
                ],
              },
            ],
          },
        } as never)
      )
      expect(out?.body.find((n) => n.kind === "row")).toBeDefined()
    })

    it("slack — a plain human message adds no block", () => {
      const out = project(
        parseSlackEventCallback("a1", "UBOT", {
          type: "event_callback",
          team_id: "T1",
          event: {
            type: "message",
            channel: "C1",
            channel_type: "channel",
            user: "U1",
            ts: "1714900000.000200",
            text: "hello",
            blocks: [{ type: "rich_text", elements: [] }],
          },
        } as never)
      )
      expect(out).toBeNull()
    })

    it("discord — gateway dispatch", () => {
      const out = project(
        parseDiscordDispatch("a1", "BOT", {
          op: 0,
          t: "MESSAGE_CREATE",
          s: 1,
          d: {
            id: "m1",
            channel_id: "c1",
            author: { id: "u1", username: "alice" },
            content: "release",
            timestamp: "2026-10-22T00:00:00.000Z",
            attachments: [],
            mentions: [],
            embeds: [{ title: "v2", description: "notes" }],
            components: [],
          },
        } as never)
      )
      expect(out?.body.find((n) => n.kind === "card")).toBeDefined()
    })

    it("telegram — Update", () => {
      const out = project(
        parseTelegramUpdate("a1", "1", {
          update_id: 7,
          message: {
            message_id: 5,
            date: 1714900000,
            chat: { id: 42, type: "private" },
            from: { id: 9, is_bot: false, first_name: "Al" },
            text: "Pay?",
            reply_markup: { inline_keyboard: [[{ text: "Pay", callback_data: "pay" }]] },
          },
        } as never)
      )
      expect(out?.body.find((n) => n.kind === "row")).toBeDefined()
    })

    it("lark — the converted card form im.message.receive_v1 delivers", () => {
      const out = project(
        parseLarkEventEnvelope("a1", "ou_bot", {
          schema: "2.0",
          header: { event_id: "e1", event_type: "im.message.receive_v1" },
          event: {
            sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
            message: {
              message_id: "om_1",
              chat_id: "oc_1",
              chat_type: "group",
              message_type: "interactive",
              content: JSON.stringify({
                title: "Leave request",
                elements: [
                  [{ tag: "text", text: "From Bob" }],
                  [{ tag: "button", text: "Approve" }],
                ],
              }),
            },
          },
        } as never)
      )
      expect(out?.body[0]).toEqual({ kind: "heading", level: 2, text: "Leave request" })
      expect(out?.body.find((n) => n.kind === "button")).toBeDefined()
    })
  })
})
