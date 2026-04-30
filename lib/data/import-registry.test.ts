// Dispatcher / persistence tests for the chat-import surface.

import "fake-indexeddb/auto"
import { detectFormat, importChatExport, applyImported } from "./import-registry"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

const CHATGPT_FIXTURE = [
  {
    title: "Greetings",
    create_time: 1_700_000_000,
    current_node: "n2",
    mapping: {
      n1: {
        id: "n1",
        parent: null,
        children: ["n2"],
        message: {
          id: "n1",
          create_time: 1_700_000_001,
          author: { role: "user" },
          content: { content_type: "text", parts: ["Hello"] },
        },
      },
      n2: {
        id: "n2",
        parent: "n1",
        children: [],
        message: {
          id: "n2",
          create_time: 1_700_000_002,
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Hi back"] },
        },
      },
    },
  },
]

const CLAUDE_FIXTURE = [
  {
    uuid: "c1",
    name: "Test",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "Hi" },
      { uuid: "m2", sender: "assistant", text: "Hello" },
    ],
  },
]

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
})

describe("detectFormat", () => {
  it("recognizes ChatGPT, Claude, Gemini, and Cognia v3", () => {
    expect(detectFormat(CHATGPT_FIXTURE)).toBe("chatgpt")
    expect(detectFormat(CLAUDE_FIXTURE)).toBe("claude")
    expect(
      detectFormat([{ header: "Bard", title: "Asked: hi", time: "2024-01-01T00:00:00Z" }])
    ).toBe("gemini")
    expect(detectFormat({ version: "3.0", manifest: {}, payload: {} })).toBe("cognia-v3")
    expect(detectFormat({ schemaVersion: 1 })).toBe("cognia-v1")
    expect(detectFormat("nope")).toBe("unknown")
  })
})

describe("importChatExport", () => {
  it("dispatches ChatGPT input to its parser", async () => {
    const result = await importChatExport(CHATGPT_FIXTURE)
    expect(result.format).toBe("chatgpt")
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0].messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("dispatches Claude input to its parser", async () => {
    const result = await importChatExport(CLAUDE_FIXTURE)
    expect(result.format).toBe("claude")
    expect(result.conversations).toHaveLength(1)
  })

  it("throws on unknown input", async () => {
    await expect(importChatExport({ random: 1 })).rejects.toBeInstanceOf(Error)
  })
})

describe("applyImported", () => {
  it("writes sessions and messages in a single transaction", async () => {
    const result = await importChatExport(CHATGPT_FIXTURE)
    const counts = await applyImported(result.conversations)
    expect(counts.sessions).toBe(1)
    expect(counts.messages).toBe(2)

    const db = getDb()
    expect(await db.sessions.count()).toBe(1)
    expect(await db.messages.count()).toBe(2)
  })

  it("returns zero counts for an empty input", async () => {
    expect(await applyImported([])).toEqual({ sessions: 0, messages: 0 })
  })
})
