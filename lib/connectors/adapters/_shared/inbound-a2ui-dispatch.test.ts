import { projectInboundToA2UI } from "./inbound-a2ui-dispatch"

describe("projectInboundToA2UI", () => {
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
