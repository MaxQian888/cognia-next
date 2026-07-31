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
    const out = projectInboundToA2UI("discord", { content: "hi" })
    expect(out!.source).toBe("discord")
  })

  it("routes telegram payloads to the telegram mapper", () => {
    const out = projectInboundToA2UI("telegram", { text: "hi" })
    expect(out!.source).toBe("telegram")
  })

  it("routes onebot payloads to the onebot mapper", () => {
    const out = projectInboundToA2UI("onebot", { message: "hi" })
    expect(out!.source).toBe("onebot")
  })

  it("routes the Phase-2 adapters to their mappers", () => {
    expect(
      projectInboundToA2UI("wecom", { msgtype: "text", text: { content: "hi" } })!.source
    ).toBe("wecom")
    expect(
      projectInboundToA2UI("wechat-personal", {
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      })!.source
    ).toBe("wechat-personal")
    expect(
      projectInboundToA2UI("matrix", { content: { msgtype: "m.text", body: "hi" } })!.source
    ).toBe("matrix")
    expect(projectInboundToA2UI("qq-official", { d: { id: "1", content: "hi" } })!.source).toBe(
      "qq-official"
    )
    expect(
      projectInboundToA2UI("dingtalk", { msgtype: "text", text: { content: "hi" } })!.source
    ).toBe("dingtalk")
  })

  it("routes the wechat-oa XML string payload (not rejected as a non-object)", () => {
    const out = projectInboundToA2UI(
      "wechat-oa",
      "<xml><MsgType>text</MsgType><Content>hi</Content></xml>"
    )
    expect(out!.source).toBe("wechat-oa")
  })

  it("returns null for unhandled platforms", () => {
    expect(projectInboundToA2UI("email" as never, { x: 1 })).toBeNull()
  })

  it("swallows mapper exceptions and returns null", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {})
    // Slack mapper will throw when blocks is non-array.
    const out = projectInboundToA2UI("slack", { blocks: { foo: 1 } } as never)
    expect(out).toBeNull()
    spy.mockRestore()
  })
})
