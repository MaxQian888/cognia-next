/**
 * The result leg's exposure gate is the reason this file is long.
 *
 * `chatResultIndex` rows carry no session kind, so nothing in the tree stopped
 * a subagent's or an embedded workbench's tool output from being read back
 * through a channel that rejects those sessions everywhere else. Those cases
 * are pinned here first, and the message leg's contract is pinned alongside
 * them so the two legs cannot drift apart.
 */
import type { ChatSession } from "@cognia/agent-config-types"

import type { ChatSearchOutcome } from "@/lib/chat/search/engine"
import type { ChatResultIndexRow } from "@/lib/db/chat-result-index"
import {
  MAX_EXPAND,
  MAX_QUERIES,
  PROJECT_HISTORY_NOTICE,
  PROJECT_HISTORY_TIME_BUDGET_MS,
  PROJECT_HISTORY_TOOL_NAME,
  buildProjectHistoryManifestEntries,
  isProjectHistorySearchTool,
  runProjectHistorySearch,
  type ProjectHistoryMessageHit,
  type ProjectHistoryResultHit,
  type ProjectHistoryToolDeps,
} from "./project-history-tool"

const PROJECT = "proj-1"

function session(overrides: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    projectId: PROJECT,
    title: "Earlier conversation",
    createdAt: 1,
    updatedAt: 1,
    messageIds: [],
    ...overrides,
  } as ChatSession
}

function searchOutcome(
  results: Array<Partial<ChatSearchResultLike> & { messageId: string }>,
  extra: Partial<ChatSearchOutcome> = {}
): ChatSearchOutcome {
  return {
    results: results.map((row) => ({
      sessionId: "s-1",
      sessionTitle: "Earlier conversation",
      projectId: PROJECT,
      role: "assistant",
      createdAt: 1_000,
      count: 1,
      at: 0,
      snippet: { text: "we standardised on pnpm workspaces", positions: [] },
      score: 1,
      archived: false,
      otherBranchCount: 0,
      ...row,
    })),
    moreOlderHistory: false,
    indexIncomplete: false,
    ...extra,
  } as ChatSearchOutcome
}

type ChatSearchResultLike = ChatSearchOutcome["results"][number]

function resultRow(overrides: Partial<ChatResultIndexRow> = {}): ChatResultIndexRow {
  return {
    resultId: "m-9:0",
    messageId: "m-9",
    sessionId: "s-1",
    projectId: PROJECT,
    createdAt: 2_000,
    kind: "tool",
    toolName: "Bash",
    title: "pnpm test",
    preview: "42 passed",
    bytes: 120,
    searchText: "bash pnpm test 42 passed",
    ...overrides,
  }
}

function makeDeps(overrides: Partial<ProjectHistoryToolDeps> = {}): ProjectHistoryToolDeps {
  return {
    resolveProjectId: async () => PROJECT,
    drainIndex: async () => {},
    searchMessages: async () => searchOutcome([]),
    searchResults: async () => [],
    getSessions: async (ids) => ids.map((id) => session({ id })),
    locateMessage: async () => "s-1",
    buildWindow: async () => "user: why pnpm?\n\nassistant: workspaces",
    now: () => 0,
    ...overrides,
  }
}

const ctx = { sessionId: "current" }

describe("manifest", () => {
  it("ships exactly one entry under the built-in plugin id", () => {
    const entries = buildProjectHistoryManifestEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe(PROJECT_HISTORY_TOOL_NAME)
    expect(isProjectHistorySearchTool(entries[0].name)).toBe(true)
    expect(isProjectHistorySearchTool("working_set")).toBe(false)
  })

  it("bounds every array the model can send", () => {
    const props = buildProjectHistoryManifestEntries()[0].jsonSchema.properties as Record<
      string,
      { maxItems?: number }
    >
    expect(props.queries.maxItems).toBe(MAX_QUERIES)
    expect(props.expand.maxItems).toBe(MAX_EXPAND)
  })
})

describe("refusals", () => {
  it("refuses an empty call rather than searching for nothing", async () => {
    const result = await runProjectHistorySearch({}, makeDeps(), ctx)
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" })
  })

  it("refuses when the conversation belongs to no workspace", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"] },
      makeDeps({ resolveProjectId: async () => null }),
      ctx
    )
    expect(result).toMatchObject({ ok: false, code: "no_workspace" })
  })

  it("returns a structured refusal instead of throwing when a leg fails", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"] },
      makeDeps({
        searchMessages: async () => {
          throw new Error("corpus unavailable")
        },
      }),
      ctx
    )
    expect(result).toMatchObject({ ok: false, code: "search_failed", error: "corpus unavailable" })
  })
})

describe("message leg", () => {
  it("scopes the query to this workspace and fences every snippet", async () => {
    const searchMessages = jest.fn(async () => searchOutcome([{ messageId: "m-1" }]))
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({ searchMessages }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, includeArchived: false })
    )
    const hit = result.hits[0] as ProjectHistoryMessageHit
    expect(hit.kind).toBe("message")
    expect(hit.snippet).toContain("<untrusted_content>")
    expect(hit.snippet).toContain("pnpm workspaces")
    expect(hit.matchedQuery).toBe("pnpm")
    expect(result._notice).toBe(PROJECT_HISTORY_NOTICE)
  })

  it("does not return the same message twice across queries", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm", "workspaces"], scope: "messages" },
      makeDeps({ searchMessages: async () => searchOutcome([{ messageId: "m-1" }]) }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.hits).toHaveLength(1)
    expect((result.hits[0] as ProjectHistoryMessageHit).matchedQuery).toBe("pnpm")
  })

  it("withholds a hit whose snippet carries PII rather than failing the call", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({
        searchMessages: async () =>
          searchOutcome([
            { messageId: "m-1" },
            {
              messageId: "m-2",
              snippet: { text: "ping me at someone@example.com", positions: [] },
            },
          ]),
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.hits).toHaveLength(1)
    expect(result.withheldCount).toBe(1)
  })

  it("withholds a hit whose session TITLE carries PII", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({
        searchMessages: async () =>
          searchOutcome([{ messageId: "m-1", sessionTitle: "mail to someone@example.com" }]),
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.hits).toHaveLength(0)
    expect(result.withheldCount).toBe(1)
  })
})

describe("result leg — the gates the index does not provide", () => {
  async function runResults(
    rows: ChatResultIndexRow[],
    sessions: Record<string, ChatSession>
  ): Promise<ProjectHistoryResultHit[]> {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "results" },
      makeDeps({
        searchResults: async () => rows,
        getSessions: async (ids) => ids.map((id) => sessions[id]),
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    return result.hits as ProjectHistoryResultHit[]
  }

  it("returns a fenced preview for an in-project, exposed session", async () => {
    const hits = await runResults([resultRow()], { "s-1": session({ id: "s-1" }) })
    expect(hits).toHaveLength(1)
    expect(hits[0].preview).toContain("<untrusted_content>")
    expect(hits[0].toolName).toBe("Bash")
    expect(hits[0].bytes).toBe(120)
  })

  it("drops a row belonging to another workspace", async () => {
    const hits = await runResults([resultRow({ projectId: "proj-2" })], {
      "s-1": session({ id: "s-1" }),
    })
    expect(hits).toHaveLength(0)
  })

  it("drops a pre-isolation row rather than treating it as unscoped", async () => {
    const hits = await runResults([resultRow({ projectId: "" })], {
      "s-1": session({ id: "s-1" }),
    })
    expect(hits).toHaveLength(0)
  })

  it("drops a subagent transcript's tool output", async () => {
    const hits = await runResults([resultRow()], {
      "s-1": session({ id: "s-1", kind: "subagent" }),
    })
    expect(hits).toHaveLength(0)
  })

  it("drops an embedded workbench session's tool output", async () => {
    const hits = await runResults([resultRow()], {
      "s-1": session({ id: "s-1", visibility: "embedded" }),
    })
    expect(hits).toHaveLength(0)
  })

  it("drops a row whose OWNING SESSION belongs to another workspace", async () => {
    // The row agrees with the current project and the session does not. The
    // session is the authoritative source, the same way the message leg treats
    // it, so the row loses.
    const hits = await runResults([resultRow()], {
      "s-1": session({ id: "s-1", projectId: "proj-2" }),
    })
    expect(hits).toHaveLength(0)
  })

  it("drops a row whose session is archived", async () => {
    const hits = await runResults([resultRow()], {
      "s-1": session({ id: "s-1", archivedAt: 5 }),
    })
    expect(hits).toHaveLength(0)
  })

  it("drops a row whose session row is gone", async () => {
    const hits = await runResults([resultRow()], {})
    expect(hits).toHaveLength(0)
  })

  it("withholds a preview carrying PII and counts it", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "results" },
      makeDeps({
        searchResults: async () => [resultRow({ preview: "mailed someone@example.com" })],
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.hits).toHaveLength(0)
    expect(result.withheldCount).toBe(1)
  })

  it("honours the after/before window on the row itself", async () => {
    const hits = await runResults([resultRow({ createdAt: 2_000 })], {
      "s-1": session({ id: "s-1" }),
    })
    expect(hits).toHaveLength(1)
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "results", after: 3_000 },
      makeDeps({ searchResults: async () => [resultRow({ createdAt: 2_000 })] }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.hits).toHaveLength(0)
  })
})

describe("scope", () => {
  it("runs only the requested leg", async () => {
    const searchMessages = jest.fn(async () => searchOutcome([{ messageId: "m-1" }]))
    const searchResults = jest.fn(async () => [resultRow()])
    await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({ searchMessages, searchResults }),
      ctx
    )
    expect(searchResults).not.toHaveBeenCalled()

    searchMessages.mockClear()
    await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "results" },
      makeDeps({ searchMessages, searchResults }),
      ctx
    )
    expect(searchMessages).not.toHaveBeenCalled()
    expect(searchResults).toHaveBeenCalled()
  })

  it("defaults to both legs", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"] },
      makeDeps({
        searchMessages: async () => searchOutcome([{ messageId: "m-1" }]),
        searchResults: async () => [resultRow()],
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.hits.map((hit) => hit.kind)).toEqual(["message", "result"])
  })
})

describe("coverage", () => {
  it("reports indexing when the pre-query drain fails", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"] },
      makeDeps({
        drainIndex: async () => {
          throw new Error("dexie closed")
        },
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.coverage).toBe("indexing")
  })

  it("reports indexing when the backfill has not reached the oldest message", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({ searchMessages: async () => searchOutcome([], { indexIncomplete: true }) }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.coverage).toBe("indexing")
  })

  it("reports partial when older history was left unscanned", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({ searchMessages: async () => searchOutcome([], { moreOlderHistory: true }) }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.coverage).toBe("partial")
  })

  it("reports complete when nothing was cut short", async () => {
    const result = await runProjectHistorySearch(
      { queries: ["pnpm"], scope: "messages" },
      makeDeps({ searchMessages: async () => searchOutcome([{ messageId: "m-1" }]) }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.coverage).toBe("complete")
    expect(result.budget.capped).toEqual([])
  })
})

describe("the soft time budget", () => {
  it("stops starting new legs once it is spent, and names what it skipped", async () => {
    let clock = 0
    const searchMessages = jest.fn(async () => {
      clock += PROJECT_HISTORY_TIME_BUDGET_MS
      return searchOutcome([{ messageId: "m-1" }])
    })
    const searchResults = jest.fn(async () => [resultRow()])
    const result = await runProjectHistorySearch(
      { queries: ["pnpm", "workspaces"] },
      makeDeps({ searchMessages, searchResults, now: () => clock }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    // The first query ran to completion — the budget is checked BETWEEN legs,
    // it does not abort one in flight.
    expect(searchMessages).toHaveBeenCalledTimes(1)
    expect(searchResults).not.toHaveBeenCalled()
    expect(result.budget.capped).toEqual(["messages", "results"])
    expect(result.budget.timeBudgetMs).toBe(PROJECT_HISTORY_TIME_BUDGET_MS)
    expect(result.coverage).toBe("partial")
    // The hit the completed leg produced is still returned.
    expect(result.hits).toHaveLength(1)
  })
})

describe("expansion", () => {
  it("re-reads a message with its neighbours, fenced", async () => {
    const buildWindow = jest.fn(async () => "user: why pnpm?\n\nassistant: workspaces")
    const result = await runProjectHistorySearch(
      { expand: ["m-1"] },
      makeDeps({ buildWindow }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.windows).toHaveLength(1)
    expect(result.windows?.[0]).toMatchObject({ sessionId: "s-1", messageId: "m-1" })
    expect(result.windows?.[0].transcript).toContain("<untrusted_content>")
    expect(buildWindow).toHaveBeenCalledWith(
      expect.objectContaining({ span: { before: 2, after: 2 } })
    )
  })

  it("re-proves the workspace and exposure gates rather than trusting the id", async () => {
    for (const owner of [
      session({ id: "s-1", projectId: "proj-2" }),
      session({ id: "s-1", kind: "subagent" }),
      session({ id: "s-1", archivedAt: 3 }),
    ]) {
      const buildWindow = jest.fn(async () => "leaked")
      const result = await runProjectHistorySearch(
        { expand: ["m-1"] },
        makeDeps({ buildWindow, getSessions: async () => [owner] }),
        ctx
      )
      if (!result.ok) throw new Error("expected success")
      expect(result.windows).toBeUndefined()
      expect(buildWindow).not.toHaveBeenCalled()
    }
  })

  it("skips a message that no longer exists", async () => {
    const result = await runProjectHistorySearch(
      { expand: ["m-gone"] },
      makeDeps({ locateMessage: async () => null }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.windows).toBeUndefined()
  })

  it("withholds a window carrying PII", async () => {
    const result = await runProjectHistorySearch(
      { expand: ["m-1"] },
      makeDeps({ buildWindow: async () => "reach me at someone@example.com" }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.windows).toBeUndefined()
    expect(result.withheldCount).toBe(1)
  })

  it("lets one unreadable message through without sinking the others", async () => {
    const result = await runProjectHistorySearch(
      { expand: ["bad", "m-2"] },
      makeDeps({
        locateMessage: async (id) => {
          if (id === "bad") throw new Error("row read failed")
          return "s-1"
        },
      }),
      ctx
    )
    if (!result.ok) throw new Error("expected success")
    expect(result.windows).toHaveLength(1)
    expect(result.windows?.[0].messageId).toBe("m-2")
  })
})
