import type { ChatSession } from "@cognia/agent-config-types"

import type { ChatSearchTextRow } from "@/lib/db/chat-search-text"
import { buildCorpus } from "./corpus"
import { searchChatHistory, type ChatSearchDeps } from "./engine"

const NOW = 1_700_000_000_000

let seq = 0
function row(text: string, over: Partial<ChatSearchTextRow> = {}): ChatSearchTextRow {
  seq += 1
  return {
    messageId: over.messageId ?? `m${seq}`,
    sessionId: over.sessionId ?? "s1",
    projectId: over.projectId ?? "p1",
    role: over.role ?? "user",
    createdAt: over.createdAt ?? NOW - seq,
    text,
  }
}

function session(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "Untitled",
    createdAt: over.createdAt ?? NOW - 10_000,
    updatedAt: over.updatedAt ?? NOW,
    ...over,
  } as ChatSession
}

/** Deps over in-memory fixtures — no Dexie, so these run in the fast node env. */
function deps(
  rows: readonly ChatSearchTextRow[],
  sessions: readonly ChatSession[],
  over: Partial<ChatSearchDeps> = {}
): Partial<ChatSearchDeps> & { now: number } {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  return {
    now: NOW,
    loadCorpus: async () => buildCorpus(rows),
    scanOlder: async () => {},
    getSessions: async (ids) => ids.map((id) => byId.get(id)),
    isIndexComplete: async () => true,
    pendingRows: () => [],
    ...over,
  }
}

beforeEach(() => {
  seq = 0
})

describe("searchChatHistory", () => {
  it("returns nothing for a blank query without touching the corpus", async () => {
    const loadCorpus = jest.fn()
    const outcome = await searchChatHistory(
      { query: "   " },
      deps([], [], { loadCorpus: loadCorpus as never })
    )
    expect(outcome).toEqual({ results: [], moreOlderHistory: false, indexIncomplete: false })
    expect(loadCorpus).not.toHaveBeenCalled()
  })

  it("returns nothing for a non-positive limit", async () => {
    const outcome = await searchChatHistory({ query: "needle", limit: 0 }, deps([], []))
    expect(outcome.results).toEqual([])
  })

  it("finds a message and carries its snippet and offsets", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([row("look for the needle here")], [session()])
    )
    expect(outcome.results).toHaveLength(1)
    const hit = outcome.results[0]
    expect(hit.messageId).toBe("m1")
    expect(hit.sessionTitle).toBe("Untitled")
    expect(hit.count).toBe(1)
    expect(hit.at).toBe(13)
    // The snippet's positions must address the snippet, ready for MatchHighlight.
    expect(hit.snippet.positions.map((p) => hit.snippet.text[p]).join("")).toBe("needle")
  })

  it("matches case-insensitively inside an identifier", async () => {
    const outcome = await searchChatHistory(
      { query: "Memo" },
      deps([row("call useMemo here")], [session()])
    )
    expect(outcome.results).toHaveLength(1)
  })

  it("matches CJK", async () => {
    const outcome = await searchChatHistory(
      { query: "项目进度" },
      deps([row("把项目进度同步到周报")], [session()])
    )
    expect(outcome.results).toHaveLength(1)
  })

  // ---- filters ----

  it("drops a hit whose session row is gone", async () => {
    // A stale projection is not a result — it would jump nowhere.
    const outcome = await searchChatHistory({ query: "needle" }, deps([row("needle")], []))
    expect(outcome.results).toEqual([])
  })

  it("never returns a subagent transcript", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([row("needle")], [session({ kind: "subagent" })])
    )
    expect(outcome.results).toEqual([])
  })

  it("never returns an embedded workbench session", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([row("needle")], [session({ visibility: "embedded" })])
    )
    expect(outcome.results).toEqual([])
  })

  it("excludes archived conversations by default", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([row("needle")], [session({ archivedAt: NOW - 1 })])
    )
    expect(outcome.results).toEqual([])
  })

  it("includes archived conversations on request and flags them", async () => {
    const outcome = await searchChatHistory(
      { query: "needle", includeArchived: true },
      deps([row("needle")], [session({ archivedAt: NOW - 1 })])
    )
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].archived).toBe(true)
  })

  it("searches every workspace when no projectId is given", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("needle a", { messageId: "a", sessionId: "sa" }),
          row("needle b", { messageId: "b", sessionId: "sb" }),
        ],
        [session({ id: "sa", projectId: "p1" }), session({ id: "sb", projectId: "p2" })]
      )
    )
    expect(outcome.results).toHaveLength(2)
  })

  it("restricts to one workspace when asked", async () => {
    const outcome = await searchChatHistory(
      { query: "needle", projectId: "p2" },
      deps(
        [
          row("needle a", { messageId: "a", sessionId: "sa" }),
          row("needle b", { messageId: "b", sessionId: "sb" }),
        ],
        [session({ id: "sa", projectId: "p1" }), session({ id: "sb", projectId: "p2" })]
      )
    )
    expect(outcome.results.map((r) => r.messageId)).toEqual(["b"])
  })

  it("treats a pre-isolation session with no projectId as the empty workspace", async () => {
    const outcome = await searchChatHistory(
      { query: "needle", projectId: "" },
      deps([row("needle", { projectId: "" })], [session({ projectId: undefined })])
    )
    expect(outcome.results).toHaveLength(1)
  })

  // ---- not-yet-indexed messages ----

  it("finds a message that is still streaming and not yet indexed", async () => {
    // The single most likely thing a user searches for right after a turn.
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([], [session()], {
        pendingRows: () => [row("fresh needle", { messageId: "pending" })],
      })
    )
    expect(outcome.results.map((r) => r.messageId)).toEqual(["pending"])
  })

  it("does not double-count a message present both pending and indexed", async () => {
    const indexed = row("needle body", { messageId: "dup" })
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([indexed], [session()], { pendingRows: () => [indexed] })
    )
    expect(outcome.results).toHaveLength(1)
  })

  // ---- older history + coverage honesty ----

  it("scans older history when the resident corpus falls short", async () => {
    const older = row("older needle", { messageId: "old", sessionId: "s1", createdAt: NOW - 9_999 })
    const scanOlder: ChatSearchDeps["scanOlder"] = async (_before, visit) => {
      visit(older)
    }
    const outcome = await searchChatHistory(
      { query: "needle", limit: 10 },
      deps([row("resident needle", { messageId: "resident" })], [session()], { scanOlder })
    )
    expect(outcome.results.map((r) => r.messageId).sort()).toEqual(["old", "resident"])
  })

  it("passes the resident boundary as the scan cutoff so nothing is scanned twice", async () => {
    const scanOlder = jest.fn(async () => {})
    await searchChatHistory(
      { query: "needle" },
      deps([row("needle", { createdAt: 4_242 })], [session()], {
        scanOlder: scanOlder as never,
      })
    )
    expect(scanOlder).toHaveBeenCalledWith(4_242, expect.any(Function))
  })

  it("does not scan older history when nothing is resident", async () => {
    const scanOlder = jest.fn(async () => {})
    await searchChatHistory(
      { query: "needle" },
      deps([], [session()], { scanOlder: scanOlder as never })
    )
    expect(scanOlder).not.toHaveBeenCalled()
  })

  it("reports an incomplete index so the UI can say so", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([row("needle")], [session()], { isIndexComplete: async () => false })
    )
    expect(outcome.indexIncomplete).toBe(true)
  })

  it("reports a complete index when the backfill finished", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps([row("needle")], [session()], { isIndexComplete: async () => true })
    )
    expect(outcome.indexIncomplete).toBe(false)
  })

  it("honours the limit and reports that more remains", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row("needle", { messageId: `m${i}`, sessionId: "s1" })
    )
    const outcome = await searchChatHistory({ query: "needle", limit: 3 }, deps(rows, [session()]))
    expect(outcome.results).toHaveLength(3)
    expect(outcome.moreOlderHistory).toBe(true)
  })

  // ---- ranking ----

  it("ranks a title match above a plain body match", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("needle in body", { messageId: "plain", sessionId: "sa" }),
          row("needle in body", { messageId: "titled", sessionId: "sb" }),
        ],
        [
          session({ id: "sa", title: "Unrelated" }),
          session({ id: "sb", title: "All about needle" }),
        ]
      )
    )
    expect(outcome.results[0].messageId).toBe("titled")
  })

  it("ranks a recent message above an old one", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("needle", { messageId: "fresh", createdAt: NOW }),
          row("needle", { messageId: "stale", createdAt: NOW - 400 * 86_400_000 }),
        ],
        [session()]
      )
    )
    expect(outcome.results.map((r) => r.messageId)).toEqual(["fresh", "stale"])
  })

  // ---- branch dedupe ----

  it("folds a direct branch's copied message into one result", async () => {
    // `branch-session.ts` copies the visible thread into the branch as real
    // messages, so the same sentence exists in both sessions.
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("shared needle line", { messageId: "parent-msg", sessionId: "parent" }),
          row("shared needle line", { messageId: "branch-msg", sessionId: "branch" }),
        ],
        [
          session({ id: "parent", title: "Parent" }),
          session({ id: "branch", title: "Branch", parentSessionId: "parent" }),
        ]
      )
    )
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].otherBranchCount).toBe(1)
  })

  it("folds several branches of the same parent", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("shared needle", { messageId: "p", sessionId: "parent" }),
          row("shared needle", { messageId: "b1", sessionId: "branch1" }),
          row("shared needle", { messageId: "b2", sessionId: "branch2" }),
        ],
        [
          session({ id: "parent" }),
          session({ id: "branch1", parentSessionId: "parent" }),
          session({ id: "branch2", parentSessionId: "parent" }),
        ]
      )
    )
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].otherBranchCount).toBe(2)
  })

  it("folds a grandchild branch by walking the lineage", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("shared needle", { messageId: "p", sessionId: "root" }),
          row("shared needle", { messageId: "g", sessionId: "grandchild" }),
        ],
        [
          session({ id: "root" }),
          session({ id: "mid", parentSessionId: "root" }),
          session({ id: "grandchild", parentSessionId: "mid" }),
        ]
      )
    )
    expect(outcome.results).toHaveLength(1)
  })

  it("keeps the lineage root as the surviving row even when a branch outranks it", async () => {
    // The branch's title matches, so it scores higher and is seen first. The
    // sentence was still written in the parent — the branch only copied it — so
    // the parent is the row a reader should be sent to.
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("shared needle", { messageId: "p", sessionId: "root" }),
          row("shared needle", { messageId: "b", sessionId: "branch" }),
        ],
        [
          session({ id: "root", title: "Unrelated" }),
          session({ id: "branch", title: "All about needle", parentSessionId: "root" }),
        ]
      )
    )
    expect(outcome.results).toHaveLength(1)
    expect(outcome.results[0].sessionId).toBe("root")
    expect(outcome.results[0].otherBranchCount).toBe(1)
  })

  it("reports more older history when the scan fills the page before exhausting it", async () => {
    const older = Array.from({ length: 5 }, (_, i) =>
      row("needle", { messageId: `o${i}`, createdAt: 100 - i })
    )
    const scanOlder: ChatSearchDeps["scanOlder"] = async (_before, visit) => {
      for (const candidate of older) {
        if (!visit(candidate)) return
      }
      throw new Error("scan should have stopped early")
    }
    const outcome = await searchChatHistory(
      { query: "needle", limit: 1 },
      deps([row("nothing here", { createdAt: 4_242 })], [session()], { scanOlder })
    )
    expect(outcome.results).toHaveLength(1)
    expect(outcome.moreOlderHistory).toBe(true)
  })

  it("does NOT fold identical text from unrelated conversations", async () => {
    // Two people both said "ok". Collapsing those would lose a real result.
    const outcome = await searchChatHistory(
      { query: "ok" },
      deps(
        [
          row("ok", { messageId: "a", sessionId: "sa" }),
          row("ok", { messageId: "b", sessionId: "sb" }),
        ],
        [session({ id: "sa" }), session({ id: "sb" })]
      )
    )
    expect(outcome.results).toHaveLength(2)
  })

  it("does not fold across roles even inside one lineage", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("needle", { messageId: "u", sessionId: "parent", role: "user" }),
          row("needle", { messageId: "a", sessionId: "branch", role: "assistant" }),
        ],
        [session({ id: "parent" }), session({ id: "branch", parentSessionId: "parent" })]
      )
    )
    expect(outcome.results).toHaveLength(2)
  })

  it("survives a parent id pointing at a deleted session", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [row("needle", { sessionId: "orphan" })],
        [session({ id: "orphan", parentSessionId: "vanished" })]
      )
    )
    expect(outcome.results).toHaveLength(1)
  })

  it("survives a lineage cycle without hanging", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [
          row("needle", { messageId: "a", sessionId: "sa" }),
          row("needle", { messageId: "b", sessionId: "sb" }),
        ],
        [session({ id: "sa", parentSessionId: "sb" }), session({ id: "sb", parentSessionId: "sa" })]
      )
    )
    expect(outcome.results.length).toBeGreaterThan(0)
  })

  it("survives a session that names itself as its own parent", async () => {
    const outcome = await searchChatHistory(
      { query: "needle" },
      deps(
        [row("needle", { sessionId: "self" })],
        [session({ id: "self", parentSessionId: "self" })]
      )
    )
    expect(outcome.results).toHaveLength(1)
  })
})
