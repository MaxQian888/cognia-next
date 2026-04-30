// Tests for the ChatGPT importer. Sample data mirrors the shape OpenAI's
// data-export tool produces: a top-level array of conversations, each with a
// `mapping` of node ids and a `current_node` pointing at the latest leaf.

import { detectChatGPT, parseChatGPT } from "./chatgpt-import"

const SAMPLE = [
  {
    title: "Sample chat",
    create_time: 1_700_000_000,
    update_time: 1_700_000_500,
    current_node: "n3",
    mapping: {
      n1: {
        id: "n1",
        parent: null,
        children: ["n2"],
        message: {
          id: "n1",
          create_time: 1_700_000_001,
          author: { role: "user" },
          content: { content_type: "text", parts: ["Hi there"] },
        },
      },
      n2: {
        id: "n2",
        parent: "n1",
        children: ["n3"],
        message: {
          id: "n2",
          create_time: 1_700_000_002,
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Hello!"] },
        },
      },
      n3: {
        id: "n3",
        parent: "n2",
        children: [],
        message: {
          id: "n3",
          create_time: 1_700_000_003,
          author: { role: "user" },
          content: { content_type: "text", parts: ["Bye"] },
        },
      },
    },
  },
]

describe("detectChatGPT", () => {
  it("matches the conversations.json shape", () => {
    expect(detectChatGPT(SAMPLE)).toBe(true)
  })
  it("rejects non-array, empty array, missing mapping", () => {
    expect(detectChatGPT(null)).toBe(false)
    expect(detectChatGPT([])).toBe(false)
    expect(detectChatGPT([{ title: "x" }])).toBe(false)
    expect(detectChatGPT({})).toBe(false)
  })
})

describe("parseChatGPT", () => {
  it("linearizes the mapping in chronological order", async () => {
    const out = await parseChatGPT(SAMPLE, {})
    expect(out).toHaveLength(1)
    expect(out[0].session.title).toBe("Sample chat")
    expect(out[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(out[0].messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual([
      "Hi there",
      "Hello!",
      "Bye",
    ])
  })

  it("converts Unix-seconds timestamps to milliseconds", async () => {
    const out = await parseChatGPT(SAMPLE, {})
    expect(out[0].session.createdAt).toBeGreaterThan(1_500_000_000_000)
    expect(out[0].messages[0].createdAt).toBeGreaterThan(1_500_000_000_000)
  })

  it("falls back to the default title when source has none", async () => {
    const noTitle = [{ ...SAMPLE[0], title: undefined }]
    const out = await parseChatGPT(noTitle as never, { defaultTitle: "Untitled" })
    expect(out[0].session.title).toBe("Untitled")
  })

  it("skips conversations whose mapping has no usable text", async () => {
    const empty = [
      {
        title: "Empty",
        create_time: 0,
        current_node: "n1",
        mapping: {
          n1: {
            id: "n1",
            parent: null,
            children: [],
            message: { id: "n1", author: { role: "user" }, content: { parts: [""] } },
          },
        },
      },
    ]
    const out = await parseChatGPT(empty as never, {})
    expect(out).toHaveLength(0)
  })

  it("derives current_node when missing", async () => {
    const noCurrent = [{ ...SAMPLE[0], current_node: undefined }]
    const out = await parseChatGPT(noCurrent as never, {})
    expect(out[0].messages.length).toBeGreaterThan(0)
  })
})
