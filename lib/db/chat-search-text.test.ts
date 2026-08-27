// Coverage for the chat-history search-text store: idempotent projection writes,
// the delete paths that keep stale hits from surviving, and the descending lazy
// backfill's watermark. Uses fake-indexeddb so the real Dexie query path runs.

import type { StoredMessage } from "@cognia/agent-config-types"
import {
  BACKFILL_BATCH_SIZE,
  DEFAULT_CHAT_SEARCH_STATE,
  backfillChatSearchTextStep,
  countChatSearchText,
  deleteChatSearchTextForMessages,
  deleteChatSearchTextForSession,
  getChatSearchState,
  loadNewestChatSearchText,
  mentionAwareSearchText,
  projectMessageToSearchRow,
  putChatSearchText,
  reprojectSession,
  scanOlderChatSearchText,
  setChatSearchState,
  type ChatSearchTextRow,
} from "./chat-search-text"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

// A cold open of the full schema chain crosses Jest's default 5s hook timeout
// under coverage instrumentation. Mirrors the repo pattern for high-version
// tables.
jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function message(over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: over.id ?? "m1",
    sessionId: over.sessionId ?? "s1",
    role: over.role ?? "user",
    parts: over.parts ?? [{ type: "text", text: "hello world" }],
    createdAt: over.createdAt ?? 1_000,
    ...(over.projectId !== undefined ? { projectId: over.projectId } : {}),
    // Carried explicitly: the search projection reads `metadata.mentions` for
    // the citations that leave no token in `parts`.
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
  } as StoredMessage
}

function row(over: Partial<ChatSearchTextRow> = {}): ChatSearchTextRow {
  return {
    messageId: over.messageId ?? "m1",
    sessionId: over.sessionId ?? "s1",
    projectId: over.projectId ?? "p1",
    role: over.role ?? "user",
    createdAt: over.createdAt ?? 1_000,
    text: over.text ?? "hello world",
  }
}

async function seedMessages(messages: StoredMessage[]): Promise<void> {
  await getDb().messages.bulkAdd(messages)
}

describe("mentionAwareSearchText", () => {
  // Half of what an `@` pick cites is not in the message body at all: staging a
  // memory, an issue or a Feishu document leaves NO token behind, so searching
  // for what you attached used to find nothing. `metadata.mentions` is the only
  // record of those, and this is the read that makes them findable.
  it("returns the plain body when nothing was cited", () => {
    expect(mentionAwareSearchText(message())).toBe("hello world")
  })

  it("folds in the label and the token of each citation", () => {
    const text = mentionAwareSearchText(
      message({
        metadata: {
          mentions: [
            { kind: "entity", id: "issue:i1", label: "Fix the broker race", raw: "@issue:i1" },
          ],
        },
      })
    )
    expect(text).toContain("hello world")
    expect(text).toContain("Fix the broker race")
    expect(text).toContain("@issue:i1")
  })

  it("makes a citation findable even when the body is empty", () => {
    const text = mentionAwareSearchText(
      message({
        parts: [],
        metadata: { mentions: [{ kind: "doc", id: "lark:d1", label: "Release plan" }] },
      } as Partial<StoredMessage>)
    )
    expect(text).toContain("Release plan")
  })

  it("falls back to the id when a citation carries no raw token", () => {
    const text = mentionAwareSearchText(
      message({ metadata: { mentions: [{ kind: "file", id: "src/app.ts" }] } })
    )
    expect(text).toContain("src/app.ts")
  })

  it("ignores malformed entries rather than indexing junk", () => {
    const text = mentionAwareSearchText(
      message({ metadata: { mentions: [{ kind: "nope", id: "x" }, "garbage"] } })
    )
    expect(text).toBe("hello world")
  })
})

describe("projectMessageToSearchRow", () => {
  it("carries citations into the stored row", () => {
    const row = projectMessageToSearchRow(
      message({
        metadata: { mentions: [{ kind: "entity", id: "memory:m1", label: "Prefers pnpm" }] },
      })
    )
    expect(row?.text).toContain("Prefers pnpm")
  })

  it("projects a message into a lean row", () => {
    expect(
      projectMessageToSearchRow(
        message({ id: "m9", sessionId: "s9", projectId: "p9", createdAt: 42 })
      )
    ).toEqual({
      messageId: "m9",
      sessionId: "s9",
      projectId: "p9",
      role: "user",
      createdAt: 42,
      text: "hello world",
    })
  })

  it("substitutes an empty projectId for pre-isolation rows so the compound index stays total", () => {
    // Dexie omits a row from a compound index when any component key is absent,
    // so a legacy message with no projectId would be invisible to
    // `[projectId+createdAt]` — and therefore unsearchable.
    const projected = projectMessageToSearchRow(message({ projectId: undefined }))
    expect(projected?.projectId).toBe("")
  })

  it("returns null for a message whose projection is empty", () => {
    // Nothing to match against — storing it would only cost space.
    expect(projectMessageToSearchRow(message({ parts: [] }))).toBeNull()
    expect(
      projectMessageToSearchRow(message({ parts: [{ type: "text", text: "   " }] }))
    ).toBeNull()
  })

  it("projects reasoning and tool parts, not just text", () => {
    const projected = projectMessageToSearchRow(
      message({
        parts: [
          { type: "reasoning", text: "thinking about it" },
          { type: "tool-Bash", input: { command: "pnpm typecheck" } },
        ],
      } as Partial<StoredMessage>)
    )
    expect(projected?.text).toContain("thinking about it")
    expect(projected?.text).toContain("pnpm typecheck")
  })
})

describe("putChatSearchText", () => {
  it("stores rows and counts them", async () => {
    await putChatSearchText([row({ messageId: "a" }), row({ messageId: "b" })])
    expect(await countChatSearchText()).toBe(2)
  })

  it("is idempotent — re-writing the same messageId overwrites rather than duplicates", async () => {
    // This is what makes concurrent indexing across Tauri's several WebViews
    // safe without a leader election.
    await putChatSearchText([row({ messageId: "a", text: "first" })])
    await putChatSearchText([row({ messageId: "a", text: "second" })])
    expect(await countChatSearchText()).toBe(1)
    expect((await getDb().chatSearchText.get("a"))?.text).toBe("second")
  })

  it("tolerates an empty batch", async () => {
    await expect(putChatSearchText([])).resolves.toBeUndefined()
    expect(await countChatSearchText()).toBe(0)
  })
})

describe("delete paths", () => {
  it("deletes rows for the given message ids", async () => {
    await putChatSearchText([row({ messageId: "a" }), row({ messageId: "b" })])
    await deleteChatSearchTextForMessages(["a"])
    expect(await countChatSearchText()).toBe(1)
  })

  it("tolerates deleting ids that were never indexed", async () => {
    await expect(deleteChatSearchTextForMessages(["nope"])).resolves.toBeUndefined()
  })

  it("tolerates an empty id list", async () => {
    await putChatSearchText([row({ messageId: "a" })])
    await deleteChatSearchTextForMessages([])
    expect(await countChatSearchText()).toBe(1)
  })

  it("deletes every row of a session", async () => {
    await putChatSearchText([
      row({ messageId: "a", sessionId: "s1" }),
      row({ messageId: "b", sessionId: "s1" }),
      row({ messageId: "c", sessionId: "s2" }),
    ])
    await deleteChatSearchTextForSession("s1")
    expect(await countChatSearchText()).toBe(1)
    expect((await getDb().chatSearchText.toArray())[0].sessionId).toBe("s2")
  })
})

describe("reprojectSession", () => {
  it("projects every message of the session", async () => {
    await seedMessages([
      message({ id: "a", sessionId: "s1", createdAt: 1 }),
      message({ id: "b", sessionId: "s1", createdAt: 2 }),
      message({ id: "c", sessionId: "s2", createdAt: 3 }),
    ])
    const { written, removed } = await reprojectSession("s1")
    expect(written.map((r) => r.messageId).sort()).toEqual(["a", "b"])
    expect(removed).toEqual([])
    expect(await countChatSearchText()).toBe(2)
  })

  it("drops projections for messages that were truncated away", async () => {
    // `truncateAfter` removes rows. An append-only indexer would leave the
    // projection behind, so search would keep offering a jump to a message the
    // list no longer renders.
    await putChatSearchText([
      row({ messageId: "stale", sessionId: "s1" }),
      row({ messageId: "kept", sessionId: "s1" }),
    ])
    await seedMessages([message({ id: "kept", sessionId: "s1", createdAt: 1 })])

    const { removed } = await reprojectSession("s1")
    expect(removed).toEqual(["stale"])
    expect((await getDb().chatSearchText.toArray()).map((r) => r.messageId)).toEqual(["kept"])
  })

  it("drops a projection whose message no longer projects to anything", async () => {
    await putChatSearchText([row({ messageId: "emptied", sessionId: "s1" })])
    await seedMessages([message({ id: "emptied", sessionId: "s1", parts: [] })])
    const { written, removed } = await reprojectSession("s1")
    expect(written).toEqual([])
    expect(removed).toEqual(["emptied"])
    expect(await countChatSearchText()).toBe(0)
  })

  it("leaves other sessions' projections alone", async () => {
    await putChatSearchText([row({ messageId: "other", sessionId: "s2" })])
    await seedMessages([message({ id: "a", sessionId: "s1", createdAt: 1 })])
    await reprojectSession("s1")
    expect(await getDb().chatSearchText.get("other")).toBeDefined()
  })

  it("is idempotent", async () => {
    await seedMessages([message({ id: "a", sessionId: "s1", createdAt: 1 })])
    await reprojectSession("s1")
    await reprojectSession("s1")
    expect(await countChatSearchText()).toBe(1)
  })

  it("handles a session with no messages", async () => {
    await putChatSearchText([row({ messageId: "orphan", sessionId: "s1" })])
    const { written, removed } = await reprojectSession("s1")
    expect(written).toEqual([])
    expect(removed).toEqual(["orphan"])
  })
})

describe("chat search state", () => {
  it("returns a default state when nothing was ever written", async () => {
    expect(await getChatSearchState()).toEqual(DEFAULT_CHAT_SEARCH_STATE)
  })

  it("round-trips a written state", async () => {
    await setChatSearchState({ oldestProjectedAt: 500, complete: false })
    const state = await getChatSearchState()
    expect(state.oldestProjectedAt).toBe(500)
    expect(state.complete).toBe(false)
    expect(state.updatedAt).toBeGreaterThan(0)
  })

  it("keeps a single row across repeated writes", async () => {
    await setChatSearchState({ oldestProjectedAt: 500, complete: false })
    await setChatSearchState({ oldestProjectedAt: 100, complete: true })
    expect(await getDb().chatSearchState.count()).toBe(1)
    expect((await getChatSearchState()).complete).toBe(true)
  })
})

describe("backfillChatSearchTextStep", () => {
  it("reports complete immediately when there are no messages", async () => {
    const result = await backfillChatSearchTextStep()
    expect(result).toEqual({ projected: 0, complete: true })
    expect((await getChatSearchState()).complete).toBe(true)
  })

  it("walks newest-first so recent history becomes searchable first", async () => {
    await seedMessages([
      message({ id: "old", createdAt: 1, parts: [{ type: "text", text: "oldest" }] }),
      message({ id: "mid", createdAt: 2, parts: [{ type: "text", text: "middle" }] }),
      message({ id: "new", createdAt: 3, parts: [{ type: "text", text: "newest" }] }),
    ])

    const first = await backfillChatSearchTextStep({ batchSize: 2 })
    expect(first.projected).toBe(2)
    expect(first.complete).toBe(false)
    const ids = (await getDb().chatSearchText.toArray()).map((r) => r.messageId).sort()
    expect(ids).toEqual(["mid", "new"])
  })

  it("resumes from the watermark and finishes", async () => {
    await seedMessages([
      message({ id: "old", createdAt: 1 }),
      message({ id: "mid", createdAt: 2 }),
      message({ id: "new", createdAt: 3 }),
    ])
    await backfillChatSearchTextStep({ batchSize: 2 })
    const second = await backfillChatSearchTextStep({ batchSize: 2 })
    expect(second.projected).toBe(1)
    expect(second.complete).toBe(true)
    expect(await countChatSearchText()).toBe(3)
  })

  it("is a no-op once complete", async () => {
    await seedMessages([message({ id: "only", createdAt: 1 })])
    await backfillChatSearchTextStep()
    const again = await backfillChatSearchTextStep()
    expect(again).toEqual({ projected: 0, complete: true })
  })

  it("advances the watermark past messages whose projection is empty", async () => {
    // A poison row must not wedge the walk on the same batch forever — the same
    // failure `backfillStyleSampleEmbeddings` guards against.
    await seedMessages([
      message({ id: "blank", createdAt: 3, parts: [] }),
      message({ id: "real", createdAt: 2 }),
    ])
    const result = await backfillChatSearchTextStep({ batchSize: 1 })
    expect(result.projected).toBe(0)
    expect(result.complete).toBe(false)
    // Watermark moved even though nothing was stored, so the next step looks
    // at `real` rather than re-reading `blank`.
    const next = await backfillChatSearchTextStep({ batchSize: 1 })
    expect(next.projected).toBe(1)
  })

  it("defaults to BACKFILL_BATCH_SIZE", async () => {
    await seedMessages(
      Array.from({ length: BACKFILL_BATCH_SIZE + 5 }, (_, i) =>
        message({ id: `m${i}`, createdAt: i + 1 })
      )
    )
    const result = await backfillChatSearchTextStep()
    expect(result.projected).toBe(BACKFILL_BATCH_SIZE)
    expect(result.complete).toBe(false)
  })

  it("indexes messages that share a createdAt millisecond", async () => {
    // The walk is ordered by `[createdAt+id]`, so ties must not stall it.
    await seedMessages([
      message({ id: "a", createdAt: 5 }),
      message({ id: "b", createdAt: 5 }),
      message({ id: "c", createdAt: 5 }),
    ])
    await backfillChatSearchTextStep({ batchSize: 2 })
    await backfillChatSearchTextStep({ batchSize: 2 })
    expect(await countChatSearchText()).toBe(3)
  })
})

describe("loadNewestChatSearchText", () => {
  it("returns the newest rows first", async () => {
    await putChatSearchText([
      row({ messageId: "a", createdAt: 1 }),
      row({ messageId: "b", createdAt: 2 }),
      row({ messageId: "c", createdAt: 3 }),
    ])
    const rows = await loadNewestChatSearchText(2)
    expect(rows.map((r) => r.messageId)).toEqual(["c", "b"])
  })

  it("returns everything when the limit exceeds the row count", async () => {
    await putChatSearchText([row({ messageId: "a", createdAt: 1 })])
    expect(await loadNewestChatSearchText(100)).toHaveLength(1)
  })

  it("returns nothing for a non-positive limit", async () => {
    await putChatSearchText([row({ messageId: "a", createdAt: 1 })])
    expect(await loadNewestChatSearchText(0)).toEqual([])
  })
})

describe("scanOlderChatSearchText", () => {
  it("visits rows older than the cutoff, newest-first", async () => {
    await putChatSearchText([
      row({ messageId: "a", createdAt: 1 }),
      row({ messageId: "b", createdAt: 2 }),
      row({ messageId: "c", createdAt: 3 }),
    ])
    const seen: string[] = []
    await scanOlderChatSearchText(3, (r) => {
      seen.push(r.messageId)
      return true
    })
    expect(seen).toEqual(["b", "a"])
  })

  it("stops early when the visitor returns false", async () => {
    await putChatSearchText([
      row({ messageId: "a", createdAt: 1 }),
      row({ messageId: "b", createdAt: 2 }),
      row({ messageId: "c", createdAt: 3 }),
    ])
    const seen: string[] = []
    await scanOlderChatSearchText(4, (r) => {
      seen.push(r.messageId)
      return seen.length < 2
    })
    expect(seen).toEqual(["c", "b"])
  })

  it("visits nothing when no row is older than the cutoff", async () => {
    await putChatSearchText([row({ messageId: "a", createdAt: 10 })])
    const seen: string[] = []
    await scanOlderChatSearchText(10, (r) => {
      seen.push(r.messageId)
      return true
    })
    expect(seen).toEqual([])
  })
})
