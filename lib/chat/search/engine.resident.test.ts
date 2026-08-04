// Covers `engine.ts`'s DEFAULT dependencies — the resident-corpus loader, its
// cache, and the Dexie-backed session / index-state reads. `engine.test.ts`
// injects deps for everything so it can stay in the fast node project; these
// paths are only reachable with a real Dexie behind them, and they are the ones
// production actually runs.

import type { ChatSession } from "@cognia/agent-config-types"

import { putChatSearchText, setChatSearchState } from "@/lib/db/chat-search-text"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { invalidateResidentCorpus, peekResidentCorpus, searchChatHistory } from "./engine"

jest.setTimeout(30_000)

const NOW = 1_700_000_000_000

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidateResidentCorpus()
})

async function seed(): Promise<void> {
  await getDb().sessions.put({
    id: "s1",
    title: "Cache layer rewrite",
    createdAt: NOW - 10_000,
    updatedAt: NOW,
    projectId: "p1",
  } as ChatSession)
  await putChatSearchText([
    {
      messageId: "m1",
      sessionId: "s1",
      projectId: "p1",
      role: "user",
      createdAt: NOW - 1,
      text: "把项目进度同步到周报",
    },
    {
      messageId: "m2",
      sessionId: "s1",
      projectId: "p1",
      role: "assistant",
      createdAt: NOW - 2,
      text: "call useMemo to memoize it",
    },
  ])
}

afterAll(dbFixture.dispose)

describe("default dependencies", () => {
  it("loads the resident corpus from Dexie and finds a CJK match", async () => {
    await seed()
    const outcome = await searchChatHistory({ query: "项目进度" })
    expect(outcome.results.map((r) => r.messageId)).toEqual(["m1"])
    expect(outcome.results[0].sessionTitle).toBe("Cache layer rewrite")
  })

  it("matches a substring inside an identifier through the real path", async () => {
    await seed()
    const outcome = await searchChatHistory({ query: "Memo" })
    expect(outcome.results.map((r) => r.messageId)).toEqual(["m2"])
  })

  it("caches the corpus rather than re-reading Dexie per keystroke", async () => {
    await seed()
    expect(peekResidentCorpus()).toBeNull()
    await searchChatHistory({ query: "项目" })
    const first = peekResidentCorpus()
    expect(first).not.toBeNull()
    await searchChatHistory({ query: "useMemo" })
    expect(peekResidentCorpus()).toBe(first)
  })

  it("shares one in-flight load between concurrent searches", async () => {
    // Two keystrokes racing the first load must not each read 30k rows.
    await seed()
    await Promise.all([searchChatHistory({ query: "项目" }), searchChatHistory({ query: "项目" })])
    expect(peekResidentCorpus()).not.toBeNull()
  })

  it("rebuilds after invalidation", async () => {
    await seed()
    await searchChatHistory({ query: "项目" })
    const before = peekResidentCorpus()
    invalidateResidentCorpus()
    expect(peekResidentCorpus()).toBeNull()
    await searchChatHistory({ query: "项目" })
    expect(peekResidentCorpus()).not.toBe(before)
  })

  it("reads the backfill watermark for the coverage note", async () => {
    await seed()
    await setChatSearchState({ complete: false })
    expect((await searchChatHistory({ query: "项目" })).indexIncomplete).toBe(true)

    invalidateResidentCorpus()
    await setChatSearchState({ complete: true })
    expect((await searchChatHistory({ query: "项目" })).indexIncomplete).toBe(false)
  })

  it("drops a hit whose session row was deleted", async () => {
    await seed()
    await getDb().sessions.delete("s1")
    expect((await searchChatHistory({ query: "项目" })).results).toEqual([])
  })

  it("defaults to no pending rows", async () => {
    // Production wires `pendingRows` from the chat store; the default must be a
    // harmless empty list rather than a throw on surfaces that never set it.
    await seed()
    await expect(searchChatHistory({ query: "nothing-matches-this" })).resolves.toMatchObject({
      results: [],
    })
  })
})
