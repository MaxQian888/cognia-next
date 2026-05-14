import { isLarkExportShape, parseLarkExport } from "./lark"

describe("parseLarkExport", () => {
  it("returns no sources for empty input", () => {
    expect(parseLarkExport("", { twinId: "t1" })).toEqual([])
  })

  it("parses the official Lark `chat_name + messages` bundle", () => {
    const sources = parseLarkExport(
      JSON.stringify({
        chat_name: "backend-team",
        messages: [
          {
            msg_id: "1",
            sender_name: "Alice",
            create_time: 1709000000,
            msg_type: "text",
            content: { text: "Anyone seen the migration script?" },
          },
          {
            msg_id: "2",
            sender_name: "Bob",
            create_time: 1709000060,
            msg_type: "text",
            content: { text: "Sent it 5 min ago" },
          },
        ],
      }),
      { twinId: "t_a" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].filename).toContain("backend-team")
    expect(sources[0].text).toContain("### Alice")
    expect(sources[0].text).toContain("### Bob")
    expect(sources[0].text).toContain("Anyone seen the migration script?")
    expect(sources[0].baseMetadata?.platform).toBe("lark")
  })

  it("parses the unofficial `groupName + messages` shape", () => {
    const sources = parseLarkExport(
      JSON.stringify({
        groupName: "frontend",
        messages: [{ uuid: "u1", from: "Cara", ts: 1709000000, type: "text", body: "ship it" }],
      }),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("ship it")
    expect(sources[0].filename).toContain("frontend")
  })

  it("parses a normalised flat array", () => {
    const sources = parseLarkExport(
      JSON.stringify([
        { user: "Dan", text: "hi", ts: 1709000000 },
        { user: "Erin", text: "hello", ts: 1709000060 },
      ]),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("Dan")
    expect(sources[0].text).toContain("Erin")
  })

  it("isLarkExportShape detects each variant", () => {
    expect(isLarkExportShape({ chat_name: "x", messages: [] })).toBe(true)
    expect(isLarkExportShape({ groupName: "x", messages: [] })).toBe(true)
    expect(isLarkExportShape([{ user: "u", text: "t" }])).toBe(true)
    expect(isLarkExportShape({ foo: 1 })).toBe(false)
    expect(isLarkExportShape(null)).toBe(false)
  })
})
