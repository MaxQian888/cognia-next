import { projectInboundToA2UI } from "./inbound-a2ui-dispatch"
import { parseDingTalkBotMessage } from "../dingtalk/parse"
import { parseWeComMessage } from "../wecom/parse"
import { parseQQDispatch } from "../qq-official/parse"
import { parseMatrixEvent } from "../matrix/parse"
import { parseV12Event } from "../onebot/v12"
import { parseV11Event } from "../onebot/v11"
import { parseIlinkMessage } from "../wechat-personal/parse"
import { parseWechatOaXml } from "../wechat-oa/parse"
import { inboundEventToStoredParts } from "@/lib/connectors/inbound-stored-parts"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

describe("projectInboundToA2UI", () => {
  it("does not append an inline image again after legacy URL sanitization", () => {
    const block = projectInboundToA2UI(
      "onebot",
      { message: [{ type: "image", data: { url: "data:image/png;base64,AAAA" } }] },
      [{ type: "image", url: "data:image/png;base64,AAAA" }]
    )!
    expect(block.body).toHaveLength(1)
    expect(block.body[0]).toMatchObject({
      kind: "image",
      url: "inbound-media:0",
      displayUrl: "data:image/png;base64,AAAA",
    })
  })
  it("retains the occurrence count when legacy inline images exceed the shared budget", () => {
    const url = `data:image/png;base64,${"A".repeat(4 * 1024 * 1024)}`
    const block = projectInboundToA2UI(
      "onebot",
      { message: [1, 2].map(() => ({ type: "image", data: { url } })) },
      [1, 2].map((i) => ({ type: "image", url, rawUrl: `key-${i}` }))
    )!
    expect(block.body).toHaveLength(2)
    expect(block.body.filter((node) => "displayUrl" in node)).toHaveLength(1)
    // The display budget bounds renderable nodes; raw diagnostic payload is
    // retained separately and never enters model replay.
    expect(JSON.stringify(block.body).length).toBeLessThan(7 * 1024 * 1024)
  })
  it("keeps valid raw text when normalized segments are not an array", () => {
    expect(
      projectInboundToA2UI(
        "onebot",
        { message: [{ type: "text", data: { text: "valid" } }] },
        {} as never
      )?.body
    ).toEqual([{ kind: "text", text: "valid" }])
  })
  it("isolates malformed normalized siblings and applies the final node bound", () => {
    const block = projectInboundToA2UI("onebot", null, [
      { type: "text", text: "kept" },
      null,
      { type: "image", url: "key" },
    ] as never)
    expect(block?.body).toEqual([
      { kind: "text", text: "kept" },
      { kind: "image", url: "key", alt: "" },
    ])
    const many = projectInboundToA2UI(
      "onebot",
      null,
      Array.from({ length: 1002 }, (_, i) => ({ type: "image", url: `image-${i}` }))
    )!
    expect(many.body).toHaveLength(1000)
  })
  it("does not store oversize Matrix bytes inside a reference or duplicate the image", () => {
    const raw = { content: { msgtype: "m.image", url: "mxc://srv/pic", body: "pic.png" } }
    const block = projectInboundToA2UI("matrix", raw, [
      {
        type: "image",
        url: "mxc://srv/pic",
        mimeType: "image/png",
        dataBase64: "A".repeat(8 * 1024 * 1024),
      },
    ])!
    expect(block.body).toEqual([{ kind: "image", url: "mxc://srv/pic", alt: "pic.png" }])
    expect(JSON.stringify(block).length).toBeLessThan(7 * 1024 * 1024)
  })
  it("projects enriched media for display without changing the replayed segments", () => {
    const segments = [
      { type: "image" as const, url: "img_key", dataBase64: "aGVsbG8=", mimeType: "image/png" },
    ]
    const before = structuredClone(segments)
    const block = projectInboundToA2UI(
      "lark",
      { event: { message: { message_type: "image", content: '{"image_key":"img_key"}' } } },
      segments
    )
    expect(block?.body).toContainEqual({
      kind: "image",
      url: "img_key",
      displayUrl: "data:image/png;base64,aGVsbG8=",
      alt: "",
    })
    expect(segments).toEqual(before)
  })

  it("replaces Telegram file references with already enriched image bytes", () => {
    const block = projectInboundToA2UI(
      "telegram",
      { message: { message_id: 1, photo: [{ file_id: "photo1" }] } },
      [{ type: "image", url: "tg://file/photo1", dataBase64: "aGVsbG8=", mimeType: "image/jpeg" }]
    )
    expect(block?.body.filter((node) => node.kind === "image")).toEqual([
      {
        kind: "image",
        url: "tg://file/photo1",
        displayUrl: "data:image/jpeg;base64,aGVsbG8=",
        alt: "",
      },
    ])
  })
  it("returns null for nullish payload", () => {
    expect(projectInboundToA2UI("slack", undefined)).toBeNull()
    expect(projectInboundToA2UI("slack", null)).toBeNull()
  })

  it("routes slack payloads to the slack mapper", () => {
    const out = projectInboundToA2UI("slack", {
      blocks: [{ type: "header", text: { type: "plain_text", text: "Hi" } }],
    })
    expect(out!.source).toBe("slack")
  })

  it("routes lark payloads to the lark mapper", () => {
    const out = projectInboundToA2UI("lark", {
      header: { title: { content: "x" } },
      elements: [{ tag: "div", text: { content: "y" } }],
    })
    expect(out!.source).toBe("lark")
  })

  it("routes discord payloads to the discord mapper", () => {
    const out = projectInboundToA2UI("discord", { content: "hi", embeds: [{ title: "E" }] })
    expect(out!.source).toBe("discord")
  })

  it("routes telegram payloads to the telegram mapper", () => {
    const out = projectInboundToA2UI("telegram", {
      text: "hi",
      reply_markup: { inline_keyboard: [[{ text: "Go", url: "https://x.test" }]] },
    })
    expect(out!.source).toBe("telegram")
  })

  it("routes onebot payloads to the onebot mapper", () => {
    const out = projectInboundToA2UI("onebot", {
      message: [{ type: "image", data: { url: "https://x.test/a.png" } }],
    })
    expect(out!.source).toBe("onebot")
  })

  // A projection holding only the message's own text adds no structure; the
  // ordinary parts render it, so the dispatcher reports nothing.
  it.each([
    ["discord", { content: "hi" }],
    ["telegram", { text: "hi" }],
    ["onebot", { message: "hi" }],
    ["wecom", { msgtype: "text", text: { content: "hi" } }],
    ["wechat-personal", { item_list: [{ type: 1, text_item: { text: "hi" } }] }],
    ["matrix", { content: { msgtype: "m.text", body: "hi" } }],
    ["qq-official", { d: { id: "1", content: "hi" } }],
    ["dingtalk", { msgtype: "text", text: { content: "hi" } }],
    ["wechat-oa", "<xml><MsgType>text</MsgType><Content>hi</Content></xml>"],
  ] as const)("returns null for a text-only %s message", (platform, payload) => {
    expect(projectInboundToA2UI(platform, payload, [{ type: "text", text: "hi" }])).toBeNull()
  })

  it("keeps a text-only block whose text differs from the stored fallback", () => {
    // Slack's `text` field is a notification fallback, not the blocks' text.
    const out = projectInboundToA2UI(
      "slack",
      {
        text: "summary",
        blocks: [{ type: "section", text: { type: "plain_text", text: "Critical detail" } }],
      },
      [{ type: "text", text: "summary" }]
    )
    expect(out?.body).toEqual([{ kind: "text", text: "Critical detail" }])
  })

  it("keeps a converted block whose line layout the fallback lacks", () => {
    const out = projectInboundToA2UI(
      "slack",
      {
        text: "one two",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "one\ntwo" } }],
      },
      [{ type: "text", text: "one two" }]
    )
    expect(out?.body).toEqual([{ kind: "text", text: "one  \ntwo", format: "markdown" }])
  })

  it("drops a block that differs from the fallback only by hard-break spaces", () => {
    expect(
      projectInboundToA2UI("discord", { content: "one\ntwo" }, [{ type: "text", text: "one\ntwo" }])
    ).toBeNull()
  })

  it("keeps a text-only block when the caller has no segments to compare", () => {
    expect(projectInboundToA2UI("telegram", { text: "hi" })?.body).toEqual([
      { kind: "text", text: "hi" },
    ])
  })

  it("routes the Phase-2 adapters to their mappers", () => {
    expect(
      projectInboundToA2UI("matrix", {
        content: { msgtype: "m.image", body: "pic", url: "https://x.test/p.png" },
      })!.source
    ).toBe("matrix")
  })

  describe("production envelopes (what each parser stores as event.raw)", () => {
    it("unwraps the Slack Events API envelope", () => {
      const out = projectInboundToA2UI("slack", {
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "message",
          text: "fallback",
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
      })
      expect(out?.body).toEqual([
        { kind: "text", text: "**Deploy** done", format: "markdown" },
        {
          kind: "row",
          children: [{ kind: "button", label: "Open", url: "https://x.test", style: "default" }],
        },
      ])
    })

    it("reads the new revision of a Slack message_changed edit", () => {
      const out = projectInboundToA2UI("slack", {
        event: {
          type: "message",
          subtype: "message_changed",
          message: { blocks: [{ type: "header", text: { type: "plain_text", text: "New" } }] },
          previous_message: {
            blocks: [{ type: "header", text: { type: "plain_text", text: "Old" } }],
          },
        },
      })
      expect(out?.body).toEqual([{ kind: "heading", level: 2, text: "New" }])
    })

    it("unwraps the Discord gateway dispatch", () => {
      const out = projectInboundToA2UI("discord", {
        op: 0,
        t: "MESSAGE_CREATE",
        s: 3,
        d: { id: "1", content: "see", embeds: [{ title: "Release", url: "https://x.test" }] },
      })
      expect(out?.source).toBe("discord")
      expect(out?.body[0]).toEqual({ kind: "text", text: "see", format: "markdown" })
      expect(out?.body).toHaveLength(2)
    })

    it("unwraps the Telegram update and ignores updates without a message", () => {
      const keyboard = { inline_keyboard: [[{ text: "Pay", callback_data: "pay" }]] }
      for (const field of ["message", "edited_message", "channel_post", "business_message"]) {
        const out = projectInboundToA2UI("telegram", {
          update_id: 1,
          [field]: { message_id: 5, text: "invoice", reply_markup: keyboard },
        })
        expect(out?.body).toEqual([
          { kind: "text", text: "invoice" },
          { kind: "row", children: [{ kind: "button", label: "Pay", actionId: "pay" }] },
        ])
      }
      expect(
        projectInboundToA2UI("telegram", { update_id: 2, callback_query: { id: "q", data: "x" } })
      ).toBeNull()
    })
  })

  it("drops malformed nodes a mapper let through", () => {
    const out = projectInboundToA2UI("lark", {
      header: { title: { content: "T" } },
      elements: [{ tag: "markdown", content: { not: "a string" } }, { tag: "hr" }],
    })
    expect(out?.body).toEqual([{ kind: "heading", level: 2, text: "T" }, { kind: "divider" }])
  })

  it("returns null for unhandled platforms", () => {
    expect(projectInboundToA2UI("email" as never, { x: 1 })).toBeNull()
  })

  it("swallows mapper exceptions and returns null", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {})
    // Lark button behaviours must be an array; `.find` on an object throws.
    const out = projectInboundToA2UI("lark", {
      elements: [{ tag: "button", behaviors: { foo: 1 } }],
    } as never)
    expect(out).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
describe("current platform contracts through real parsers", () => {
  function project(event: NormalizedInboundEvent | null) {
    expect(event).not.toBeNull()
    if (!event) throw new Error("Expected inbound event")
    const segments = event.segments.map((segment) =>
      segment.type === "image"
        ? {
            ...segment,
            mimeType: "image/png",
            dataBase64: "RElTUExBWV9PTkxZ",
          }
        : segment
    )
    const before = structuredClone(segments)
    const out = projectInboundToA2UI(event.platform, event.raw, segments)
    const stored = inboundEventToStoredParts({ segments, plainText: event.plainText })
    expect(segments).toEqual(before)
    expect(stored.every((part) => part.type === "text")).toBe(true)
    expect(JSON.stringify(stored)).not.toMatch(/RElTUExBWV9PTkxZ|data:image|displayUrl/)
    return out
  }

  it("projects personal WeChat media without duplicating it or replaying display bytes", () => {
    const event = parseIlinkMessage("wx", {
      message_id: "18446744073709551600",
      message_type: 1,
      from_user_id: "user",
      to_user_id: "bot",
      context_token: "context",
      item_list: [
        { type: 1, text_item: { text: "personal caption" } },
        { type: 2, image_item: { media: { full_url: "https://cdn/encrypted" } } },
      ],
    })
    const block = project(event)!
    expect(block.body).toHaveLength(2)
    expect(block.body[0]).toEqual({ kind: "text", text: "personal caption" })
    expect(block.body[1]).toMatchObject({
      kind: "image",
      displayUrl: "data:image/png;base64,RElTUExBWV9PTkxZ",
    })
    expect(event?.messageId).toBe("18446744073709551600")
  })

  it("projects OA XML media and retains its exact uint64 identity through stored text", () => {
    const event = parseWechatOaXml(
      "oa",
      "account",
      "<xml><ToUserName>account</ToUserName><FromUserName>user</FromUserName><CreateTime>1</CreateTime><MsgType>image</MsgType><MsgId>18446744073709551601</MsgId><MediaId>image-id</MediaId><PicUrl>https://cdn/image</PicUrl></xml>"
    )
    const block = project(event)!
    expect(block.body).toHaveLength(1)
    expect(block.body[0]).toMatchObject({
      kind: "image",
      displayUrl: "data:image/png;base64,RElTUExBWV9PTkxZ",
    })
    expect(event?.messageId).toBe("18446744073709551601")
  })

  it("keeps nested DingTalk inline pictures between text runs", () => {
    const out = project(
      parseDingTalkBotMessage("ad", "bot", {
        msgId: "m",
        conversationId: "c",
        conversationType: "1",
        msgtype: "richText",
        content: {
          richText: [
            { text: "before" },
            { type: "picture", downloadCode: "code" },
            { text: "after" },
          ],
        },
      })
    )
    expect(out?.body).toEqual([
      { kind: "text", text: "before" },
      {
        kind: "image",
        url: "dingtalk://download/code",
        alt: "",
        displayUrl: "data:image/png;base64,RElTUExBWV9PTkxZ",
      },
      { kind: "text", text: "after" },
    ])
  })

  it("keeps quoted WeCom media before recognized speech", () => {
    const out = project(
      parseWeComMessage("ad", "bot", {
        msgid: "m",
        aibotid: "bot",
        chattype: "single",
        from: { userid: "u" },
        msgtype: "voice",
        voice: { content: "recognized" },
        quote: { msgtype: "image", image: { url: "https://cdn/quote" } },
      })
    )
    expect(out?.body.map((node) => node.kind)).toEqual(["card", "text"])
    expect(out?.body[0]).toMatchObject({
      children: [{ kind: "image", displayUrl: "data:image/png;base64,RElTUExBWV9PTkxZ" }],
    })
  })

  it("keeps OneBot v11 CQ text and repeated pictures in their original positions", () => {
    const out = project(
      parseV11Event("ad", {
        post_type: "message",
        message_type: "private",
        self_id: 9,
        user_id: 1,
        message_id: 2,
        time: 1,
        message: "[CQ:image,url=https://cdn/p]A &amp; B[CQ:image,url=https://cdn/p]",
        sender: { user_id: 1, nickname: "Alice" },
      })
    )
    expect(out?.body.map((node) => node.kind)).toEqual(["image", "text", "image"])
    expect(out?.body[1]).toEqual({ kind: "text", text: "A & B" })
  })

  it("keeps OneBot v12 reply, all-mention, audio, file, location and image", () => {
    const out = project(
      parseV12Event("ad", {
        id: "e",
        type: "message",
        detail_type: "private",
        self: { platform: "qq", user_id: "bot" },
        time: 1,
        user_id: "u",
        message_id: "m",
        message: [
          { type: "reply", data: { message_id: "old" } },
          { type: "mention_all", data: {} },
          { type: "audio", data: { file_id: "audio" } },
          { type: "file", data: { file_id: "file", name: "report.pdf" } },
          { type: "location", data: { latitude: 31.2, longitude: 121.5, title: "Shanghai" } },
          { type: "image", data: { file_id: "pic" } },
        ],
      })
    )
    expect(out?.body.map((node) => node.kind)).toEqual([
      "reply_context",
      "mention",
      "link",
      "link",
      "text",
      "image",
    ])
    expect(out?.body[0]).toMatchObject({ replyToMessageId: "old" })
    expect(out?.body[4]).toMatchObject({ text: "Shanghai (31.2, 121.5)" })
    expect(out?.body.filter((node) => node.kind === "image")).toHaveLength(1)
  })

  it("normalizes QQ attachments once alongside the original reference", () => {
    const out = project(
      parseQQDispatch("ad", "bot", {
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "m",
          author: { user_openid: "u" },
          message_reference: { message_id: "old" },
          attachments: [
            { url: "//cdn/p", content_type: "image/png" },
            { url: "cdn/f", filename: "report.pdf" },
          ],
        },
      })
    )
    expect(out?.body.map((node) => node.kind)).toEqual(["reply_context", "image", "link"])
    expect(out?.body[1]).toMatchObject({
      url: "https://cdn/p",
      displayUrl: "data:image/png;base64,RElTUExBWV9PTkxZ",
    })
  })

  it("keeps Matrix captions and decrypted image bytes in separate storage fields", () => {
    const out = project(
      parseMatrixEvent("ad", "@bot:srv", "!room:srv", {
        type: "m.room.message",
        event_id: "$m",
        sender: "@u:srv",
        origin_server_ts: 1,
        content: {
          msgtype: "m.image",
          url: "mxc://srv/pic",
          filename: "pic.png",
          body: "visible caption",
        },
      })
    )
    expect(out?.body.map((node) => node.kind)).toEqual(["image", "text"])
    expect(out?.body[1]).toEqual({ kind: "text", text: "visible caption" })
    expect(out?.body[0]).toMatchObject({ displayUrl: "data:image/png;base64,RElTUExBWV9PTkxZ" })
  })
})
