import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { CHUNK_TARGET_CHARS, RESIDENT_MESSAGE_CAP, buildCorpus } from "./corpus"

let seq = 0
function row(text: string, over: Partial<ChatSearchTextRow> = {}): ChatSearchTextRow {
  seq += 1
  return {
    messageId: over.messageId ?? `m${seq}`,
    sessionId: over.sessionId ?? "s1",
    projectId: over.projectId ?? "p1",
    role: over.role ?? "user",
    // Newest-first input is the contract (see `loadNewestChatSearchText`), so
    // tests that care about order pass `createdAt` explicitly.
    createdAt: over.createdAt ?? 1_000 - seq,
    text,
  }
}

beforeEach(() => {
  seq = 0
})

describe("buildCorpus", () => {
  it("reports empty stats for no rows", () => {
    const corpus = buildCorpus([])
    expect(corpus.size).toBe(0)
    expect(corpus.chars).toBe(0)
    expect(corpus.oldestResidentAt).toBeNull()
    expect(corpus.search("anything", 10)).toEqual([])
  })

  it("reports resident size and character count", () => {
    const corpus = buildCorpus([row("abcd"), row("ef")])
    expect(corpus.size).toBe(2)
    expect(corpus.chars).toBe(6)
  })

  it("exposes the oldest resident timestamp as the older-history boundary", () => {
    const corpus = buildCorpus([row("new", { createdAt: 30 }), row("old", { createdAt: 10 })])
    expect(corpus.oldestResidentAt).toBe(10)
  })

  // ---- matching ----

  it("finds a needle and reports its offset within the row's own text", () => {
    const corpus = buildCorpus([row("the needle is here")])
    expect(corpus.search("needle", 10)).toEqual([
      { row: expect.objectContaining({ messageId: "m1" }), at: 4, count: 1 },
    ])
  })

  it("attributes a hit to the right row when several are resident", () => {
    const corpus = buildCorpus([row("alpha"), row("bravo needle"), row("charlie")])
    const hits = corpus.search("needle", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].row.messageId).toBe("m2")
    expect(hits[0].at).toBe(6)
  })

  it("counts every occurrence within a row but returns one hit per row", () => {
    const corpus = buildCorpus([row("needle and needle again")])
    const hits = corpus.search("needle", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].count).toBe(2)
    expect(hits[0].at).toBe(0)
  })

  it("counts overlapping occurrences the way find-in-conversation does", () => {
    const corpus = buildCorpus([row("aaa")])
    expect(corpus.search("aa", 10)[0].count).toBe(2)
  })

  it("never matches across a row boundary", () => {
    // Without a separator, "ab" would match the join of "…a" and "b…" and be
    // attributed to a message that never contained it.
    const corpus = buildCorpus([row("xxxa"), row("bxxx")])
    expect(corpus.search("ab", 10)).toEqual([])
  })

  it("matches case-insensitively", () => {
    const corpus = buildCorpus([row("The useMemo Hook")])
    const hits = corpus.search("USEMEMO", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].at).toBe(4)
  })

  it("matches a substring inside a longer identifier", () => {
    // The behaviour a token-based index would have lost.
    const corpus = buildCorpus([row("call useMemo here")])
    expect(corpus.search("Memo", 10)).toHaveLength(1)
  })

  it("matches CJK text", () => {
    const corpus = buildCorpus([row("把项目进度同步到周报")])
    const hits = corpus.search("项目进度", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].at).toBe(1)
  })

  it("trims the needle", () => {
    const corpus = buildCorpus([row("the needle")])
    expect(corpus.search("  needle  ", 10)).toHaveLength(1)
  })

  it("returns nothing for a blank needle", () => {
    const corpus = buildCorpus([row("anything")])
    expect(corpus.search("", 10)).toEqual([])
    expect(corpus.search("   ", 10)).toEqual([])
  })

  it("ignores NUL in a needle rather than letting it match the row separator", () => {
    const corpus = buildCorpus([row("alpha"), row("bravo")])
    expect(corpus.search("\u0000", 10)).toEqual([])
    expect(corpus.search("alpha\u0000bravo", 10)).toEqual([])
  })

  // ---- bounds and ordering ----

  it("neutralizes a NUL inside a message body without shifting offsets", () => {
    // `projectSearchText` collapses `\s+`, and NUL is not `\s`, so a message can
    // genuinely carry one. Left in place it would read as a row separator and
    // split one message into two members' worth of offsets.
    const corpus = buildCorpus([row(`pre${"\u0000"}needle`)])
    const hits = corpus.search("needle", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].at).toBe(4)
  })

  it("returns hits newest-first, following the input order", () => {
    const corpus = buildCorpus([
      row("needle newest", { createdAt: 30 }),
      row("needle middle", { createdAt: 20 }),
      row("needle oldest", { createdAt: 10 }),
    ])
    expect(corpus.search("needle", 10).map((h) => h.row.createdAt)).toEqual([30, 20, 10])
  })

  it("stops at the requested limit", () => {
    const corpus = buildCorpus(Array.from({ length: 20 }, () => row("needle")))
    expect(corpus.search("needle", 5)).toHaveLength(5)
  })

  it("returns nothing for a non-positive limit", () => {
    const corpus = buildCorpus([row("needle")])
    expect(corpus.search("needle", 0)).toEqual([])
  })

  it("searches across chunk boundaries", () => {
    // Force several chunks so the hit lands in a later one.
    const filler = "z".repeat(200)
    const rows = Array.from({ length: 20 }, () => row(filler))
    rows.push(row("the needle"))
    const corpus = buildCorpus(rows, { chunkTargetChars: 500 })
    const hits = corpus.search("needle", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].at).toBe(4)
  })

  it("evicts the oldest rows past the resident cap", () => {
    const rows = [
      row("keep me", { createdAt: 30 }),
      row("keep me too", { createdAt: 20 }),
      row("evict me", { createdAt: 10 }),
    ]
    const corpus = buildCorpus(rows, { residentCap: 2 })
    expect(corpus.size).toBe(2)
    expect(corpus.oldestResidentAt).toBe(20)
    expect(corpus.search("evict", 10)).toEqual([])
  })

  it("skips a fully tombstoned tail when reporting the oldest resident timestamp", () => {
    // Below the compaction threshold, so the dead rows are still in their chunks.
    // The boundary must walk past them: reporting the tombstoned row's timestamp
    // would make the older-history scan start too late and skip live messages.
    const rows = [
      row("a", { messageId: "r0", createdAt: 50 }),
      row("b", { messageId: "r1", createdAt: 40 }),
      row("c", { messageId: "r2", createdAt: 30 }),
      row("d", { messageId: "r3", createdAt: 20 }),
      row("e", { messageId: "r4", createdAt: 10 }),
    ]
    const corpus = buildCorpus(rows, { chunkTargetChars: 1 })
    corpus.remove(["r4", "r3"])
    expect(corpus.size).toBe(3)
    expect(corpus.haystackChars).toBe(5)
    expect(corpus.oldestResidentAt).toBe(30)
  })

  it("reports no oldest timestamp once every resident row is tombstoned", () => {
    // The boundary the older-history scan uses must degrade to "nothing is
    // resident", not to a stale timestamp that would skip the gap.
    const corpus = buildCorpus([row("a", { messageId: "x" }), row("b", { messageId: "y" })])
    corpus.remove(["x", "y"])
    expect(corpus.size).toBe(0)
    expect(corpus.oldestResidentAt).toBeNull()
  })

  it("has sane production defaults", () => {
    expect(RESIDENT_MESSAGE_CAP).toBeGreaterThan(0)
    expect(CHUNK_TARGET_CHARS).toBeGreaterThan(0)
  })

  // ---- incremental maintenance ----

  it("fold makes a new message findable without a rebuild", () => {
    const corpus = buildCorpus([row("old body", { createdAt: 10 })])
    corpus.fold([row("fresh needle", { messageId: "fresh", createdAt: 50 })])
    const hits = corpus.search("needle", 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].row.messageId).toBe("fresh")
    expect(corpus.size).toBe(2)
  })

  it("fold keeps the newest-first ordering", () => {
    const corpus = buildCorpus([row("needle old", { createdAt: 10 })])
    corpus.fold([row("needle new", { createdAt: 50 })])
    expect(corpus.search("needle", 10).map((h) => h.row.createdAt)).toEqual([50, 10])
  })

  it("fold re-adding the same messageId does not double-count it", () => {
    // The idempotent-write property has to hold in memory too, or a re-projected
    // message would show up twice in the result list.
    const corpus = buildCorpus([row("body", { messageId: "dup", createdAt: 10 })])
    corpus.fold([row("body needle", { messageId: "dup", createdAt: 10 })])
    expect(corpus.search("needle", 10)).toHaveLength(1)
    expect(corpus.size).toBe(1)
  })

  it("fold merges back-dated rows by createdAt instead of prepending them", () => {
    // An external-agent history import writes years-old transcripts. Prepending
    // them would leave `oldestResidentAt` naming a recent instant, so the
    // cursor handed to `scanOlderChatSearchText` would skip every message
    // between the true oldest row and that instant.
    const corpus = buildCorpus([
      row("recent needle", { messageId: "new", createdAt: 900 }),
      row("older needle", { messageId: "mid", createdAt: 500 }),
    ])
    corpus.fold([
      row("imported needle", { messageId: "imported", createdAt: 10 }),
      row("imported needle too", { messageId: "imported2", createdAt: 20 }),
    ])

    expect(corpus.search("needle", 10).map((h) => h.row.messageId)).toEqual([
      "new",
      "mid",
      "imported2",
      "imported",
    ])
    expect(corpus.oldestResidentAt).toBe(10)
  })

  it("fold tolerates an empty batch", () => {
    const corpus = buildCorpus([row("body")])
    corpus.fold([])
    expect(corpus.size).toBe(1)
  })

  it("remove makes a deleted message unfindable", () => {
    const corpus = buildCorpus([row("needle here", { messageId: "gone" }), row("other")])
    corpus.remove(["gone"])
    expect(corpus.search("needle", 10)).toEqual([])
    expect(corpus.size).toBe(1)
  })

  it("remove tolerates unknown ids and empty input", () => {
    const corpus = buildCorpus([row("needle")])
    corpus.remove([])
    corpus.remove(["never-indexed"])
    expect(corpus.search("needle", 10)).toHaveLength(1)
  })

  it("compacts once tombstones dominate, so removed text stops being scanned", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row("needle", { messageId: `r${i}` }))
    const corpus = buildCorpus(rows)
    // 10 bodies of 6 chars plus 9 separators.
    expect(corpus.haystackChars).toBe(69)
    corpus.remove(rows.slice(0, 9).map((r) => r.messageId))
    expect(corpus.size).toBe(1)
    // `haystackChars`, not `chars`: the latter already excludes tombstoned rows,
    // so only this proves the concatenated body was actually rebuilt rather than
    // carrying nine dead bodies through every future scan.
    expect(corpus.haystackChars).toBe(6)
  })

  it("keeps a removed body in the haystack until the compaction threshold", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row("needle", { messageId: `r${i}` }))
    const corpus = buildCorpus(rows)
    corpus.remove(["r0"])
    expect(corpus.size).toBe(9)
    expect(corpus.haystackChars).toBe(69)
    expect(corpus.search("needle", 20)).toHaveLength(9)
  })
})
