import { isChatgptExportShape, parseChatgptExport } from "./chatgpt"

describe("parseChatgptExport", () => {
  it("returns no sources for empty input", () => {
    expect(parseChatgptExport("", { twinId: "t1" })).toEqual([])
  })

  it("emits one source per conversation, reconstructing the linear path", () => {
    const conv = {
      title: "Backend refactor planning",
      mapping: {
        root: { id: "root", message: null, children: ["a"] },
        a: {
          id: "a",
          message: {
            id: "a",
            author: { role: "user" },
            create_time: 1700000000,
            content: { content_type: "text", parts: ["How do I refactor X?"] },
          },
          parent: "root",
          children: ["b"],
        },
        b: {
          id: "b",
          message: {
            id: "b",
            author: { role: "assistant" },
            create_time: 1700000060,
            content: { content_type: "text", parts: ["Start by..."] },
          },
          parent: "a",
          children: ["c"],
        },
        c: {
          id: "c",
          message: {
            id: "c",
            author: { role: "user" },
            create_time: 1700000120,
            content: { content_type: "text", parts: ["Then?"] },
          },
          parent: "b",
          children: [],
        },
      },
      current_node: "c",
    }
    const sources = parseChatgptExport(JSON.stringify([conv]), { twinId: "twin_alice" })
    expect(sources).toHaveLength(1)
    const source = sources[0]
    expect(source.format).toBe("markdown")
    expect(source.filename).toContain("Backend refactor planning")
    expect(source.text).toContain("### User")
    expect(source.text).toContain("How do I refactor X?")
    expect(source.text).toContain("### ChatGPT")
    expect(source.text).toContain("Start by...")
    expect(source.baseMetadata?.speakers).toEqual(["User", "ChatGPT"])
    expect(source.baseMetadata?.platform).toBe("chatgpt")
  })

  it("skips system messages and empty content", () => {
    const conv = {
      title: "T",
      mapping: {
        root: { id: "root", message: null, children: ["s", "u"] },
        s: {
          id: "s",
          message: {
            id: "s",
            author: { role: "system" },
            content: { parts: ["You are a helpful assistant"] },
          },
          parent: "root",
          children: ["u"],
        },
        u: {
          id: "u",
          message: {
            id: "u",
            author: { role: "user" },
            create_time: 1700000000,
            content: { parts: ["Question"] },
          },
          parent: "s",
          children: [],
        },
      },
      current_node: "u",
    }
    const [source] = parseChatgptExport(JSON.stringify(conv), { twinId: "t1" })
    expect(source.text).not.toContain("You are a helpful assistant")
    expect(source.text).toContain("Question")
  })

  it("handles bundles with multiple conversations independently", () => {
    const sources = parseChatgptExport(
      JSON.stringify([
        {
          title: "Chat 1",
          mapping: {
            a: {
              id: "a",
              message: {
                author: { role: "user" },
                content: { parts: ["one"] },
              },
              children: [],
            },
          },
          current_node: "a",
        },
        {
          title: "Chat 2",
          mapping: {
            b: {
              id: "b",
              message: {
                author: { role: "user" },
                content: { parts: ["two"] },
              },
              children: [],
            },
          },
          current_node: "b",
        },
      ]),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(2)
    expect(sources[0].text).toContain("one")
    expect(sources[1].text).toContain("two")
  })

  it("falls back to deepest leaf when current_node is missing", () => {
    const sources = parseChatgptExport(
      JSON.stringify({
        title: "Stub",
        mapping: {
          a: {
            id: "a",
            message: {
              author: { role: "user" },
              create_time: 100,
              content: { parts: ["older"] },
            },
            children: [],
          },
          b: {
            id: "b",
            message: {
              author: { role: "assistant" },
              create_time: 200,
              content: { parts: ["newer"] },
            },
            parent: "a",
            children: [],
          },
        },
      }),
      { twinId: "t1" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("newer")
  })

  it("detects ChatGPT shape via isChatgptExportShape", () => {
    expect(isChatgptExportShape([{ mapping: {} }])).toBe(true)
    expect(isChatgptExportShape({ mapping: {} })).toBe(true)
    expect(isChatgptExportShape({ chat_messages: [] })).toBe(false)
    expect(isChatgptExportShape(null)).toBe(false)
    expect(isChatgptExportShape("hello")).toBe(false)
  })
})
