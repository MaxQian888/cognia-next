import { isWechatExportShape, parseWechatExport } from "./wechat"

describe("parseWechatExport", () => {
  it("returns no sources for empty input", () => {
    expect(parseWechatExport("[]", { twinId: "t1" })).toEqual([])
  })

  it("parses the chatlog CSV-like JSON array", () => {
    const sources = parseWechatExport(
      JSON.stringify([
        {
          Timestamp: "2024-03-01 10:00:00",
          Sender: "Alice",
          Type: "Text",
          Content: "你好",
        },
        {
          Timestamp: "2024-03-01 10:01:00",
          Sender: "Bob",
          Type: "Text",
          Content: "你好呀",
        },
        // Non-text message — filtered out.
        {
          Timestamp: "2024-03-01 10:02:00",
          Sender: "Bob",
          Type: "Image",
          Content: "(image)",
        },
      ]),
      { twinId: "t_a" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("Alice")
    expect(sources[0].text).toContain("你好")
    expect(sources[0].text).not.toContain("(image)")
    expect(sources[0].baseMetadata?.platform).toBe("wechat")
  })

  it("parses the WechatExporter `chats` bundle and fans out per chat", () => {
    const sources = parseWechatExport(
      JSON.stringify({
        chats: [
          {
            name: "Project Alpha",
            msgs: [
              { from: "Alice", time: 1709000000, content: "msg1", type: 1 },
              { from: "Bob", time: 1709000060, content: "msg2", type: 1 },
              // Filtered (type 3 = image).
              { from: "Bob", time: 1709000120, content: "[img]", type: 3 },
            ],
          },
          {
            name: "Project Beta",
            msgs: [{ from: "Carol", time: 1709001000, content: "hi", type: 1 }],
          },
        ],
      }),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(2)
    expect(sources[0].filename).toContain("Project Alpha")
    expect(sources[0].text).toContain("msg1")
    expect(sources[0].text).not.toContain("[img]")
    expect(sources[1].filename).toContain("Project Beta")
  })

  it("parses a normalised flat array", () => {
    const sources = parseWechatExport(
      JSON.stringify([
        { user: "X", text: "hi", ts: 1709000000 },
        { user: "Y", text: "hello", ts: 1709000060 },
      ]),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("X")
    expect(sources[0].text).toContain("Y")
  })

  it("isWechatExportShape recognises the variants", () => {
    expect(isWechatExportShape({ chats: [] })).toBe(true)
    expect(isWechatExportShape({ messages: [] })).toBe(true)
    expect(isWechatExportShape([{ Sender: "X", Content: "y" }])).toBe(true)
    expect(isWechatExportShape([{ user: "X", text: "y" }])).toBe(true)
    expect(isWechatExportShape({ foo: 1 })).toBe(false)
    expect(isWechatExportShape(null)).toBe(false)
  })
})
