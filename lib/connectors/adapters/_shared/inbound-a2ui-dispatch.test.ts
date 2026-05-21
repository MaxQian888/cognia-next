import { projectInboundToA2UI } from "./inbound-a2ui-dispatch"

describe("projectInboundToA2UI", () => {
  it("returns null for missing payload", () => {
    expect(projectInboundToA2UI("slack", undefined)).toBeNull()
    expect(projectInboundToA2UI("slack", null)).toBeNull()
    expect(projectInboundToA2UI("slack", "not-an-object")).toBeNull()
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

  it("returns null for unknown platforms", () => {
    expect(projectInboundToA2UI("matrix" as never, { x: 1 })).toBeNull()
  })

  it("swallows mapper exceptions and returns null", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {})
    // Slack mapper will throw when blocks is non-array.
    const out = projectInboundToA2UI("slack", { blocks: { foo: 1 } } as never)
    expect(out).toBeNull()
    spy.mockRestore()
  })
})
