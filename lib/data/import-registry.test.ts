// Dispatcher / persistence tests for the chat-import surface.

import "fake-indexeddb/auto"
import {
  detectFormat,
  importChatExport,
  applyImported,
  registerChatImporter,
  unregisterChatImporter,
  unregisterImportersByPlugin,
  __resetDynamicImportersForTesting,
} from "./import-registry"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import type { ChatImporter } from "./importers/types"

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

// ============================================================================
// §A-4 — runtime importer overlay (plugin contributions)
// ============================================================================

describe("dynamic importer overlay", () => {
  // A toy importer that only matches a unique sentinel object so we never
  // collide with the static formats. Each test provides a fresh function so
  // we can compare object identity in unregister() calls.

  type FakePayload = { __fake: true }
  function makeFakeImporter(): ChatImporter<FakePayload> {
    return {
      format: "fake-plugin-format" as never,
      detect: (data: unknown): data is FakePayload =>
        typeof data === "object" && data !== null && (data as { __fake?: boolean }).__fake === true,
      parse: async () => [],
    }
  }

  afterEach(() => {
    __resetDynamicImportersForTesting()
  })

  it("registerChatImporter makes a new format detectable", () => {
    const fake = makeFakeImporter()
    expect(detectFormat({ __fake: true })).toBe("unknown")
    registerChatImporter(fake, { pluginId: "plug" })
    expect(detectFormat({ __fake: true })).toBe("fake-plugin-format")
  })

  it("static REGISTRY wins when both static and dynamic detect the same input", () => {
    // A plugin that wrongly claims it can parse ChatGPT exports — the static
    // chatgpt importer still wins because it's iterated first.
    const greedy: ChatImporter<unknown> = {
      format: "fake-plugin-format" as never,
      detect: (_data: unknown): _data is unknown => true, // matches everything
      parse: async () => [],
    }
    registerChatImporter(greedy, { pluginId: "plug" })
    expect(detectFormat(CHATGPT_FIXTURE)).toBe("chatgpt")
  })

  it("unregisterChatImporter removes a single dynamic entry by reference", () => {
    const fake = makeFakeImporter()
    registerChatImporter(fake)
    expect(unregisterChatImporter(fake)).toBe(true)
    expect(detectFormat({ __fake: true })).toBe("unknown")
    // Idempotent: a second call returns false because nothing matched.
    expect(unregisterChatImporter(fake)).toBe(false)
  })

  it("unregisterImportersByPlugin removes only that plugin's importers", () => {
    const a = makeFakeImporter()
    const b = makeFakeImporter()
    const c = makeFakeImporter()
    registerChatImporter(a, { pluginId: "p1" })
    registerChatImporter(b, { pluginId: "p1" })
    registerChatImporter(c, { pluginId: "p2" })

    const removed = unregisterImportersByPlugin("p1")
    expect(removed).toBe(2)
    // p2's importer survives.
    expect(detectFormat({ __fake: true })).toBe("fake-plugin-format")
  })
})
