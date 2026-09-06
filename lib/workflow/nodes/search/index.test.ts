/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const runGlobalSearch = jest.fn(
  async (_q: unknown, _c: unknown, _o: unknown): Promise<unknown> => ({
    groups: [],
    totalHits: 0,
    coverage: "complete",
    truncated: false,
    tookMs: 1,
    aborted: false,
  })
)
jest.mock("@/lib/global-search/engine", () => ({
  ...jest.requireActual("@/lib/global-search/engine"),
  runGlobalSearch: (q: unknown, c: unknown, o: unknown) => runGlobalSearch(q, c, o),
}))

const searchChatHistory = jest.fn(async (_q: unknown): Promise<unknown> => ({
  results: [],
  moreOlderHistory: false,
  indexIncomplete: false,
}))
jest.mock("@/lib/chat/search/engine", () => ({
  searchChatHistory: (q: unknown) => searchChatHistory(q),
}))

import "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

const logs: Array<[string, string]> = []

function run(kind: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
    projectId: "proj1",
    signal: new AbortController().signal,
    log: (level: string, message: string) => logs.push([level, message]),
    ...extra,
  } as unknown as StepExecutionContext)
}

function group(kind: string, count: number, over: Record<string, unknown> = {}) {
  return {
    kind,
    providerId: `p_${kind}`,
    bestScore: 1,
    total: count,
    truncated: false,
    coverage: "complete",
    items: Array.from({ length: count }, (_, i) => ({
      id: `${kind}_${i}`,
      title: `${kind} ${i}`,
      subtitle: "sub",
      score: 1,
      timestamp: 10,
      icon: { lucide: function Icon() {} },
      action: { type: "open-session", sessionId: `sess_${i}`, run: () => undefined },
    })),
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  logs.length = 0
})

describe("registration", () => {
  it.each(["action.search.query", "action.search.messages"])("registers %s", (kind) => {
    expect(getExecutor(kind as never, 1)).toBeDefined()
  })
})

describe("action.search.query", () => {
  it("passes an explicit provider list that excludes the UI-only kinds", async () => {
    await run("action.search.query", { query: "notes" })
    const providers = (
      runGlobalSearch.mock.calls[0][2] as { providers: Array<{ kinds?: string[] }> }
    ).providers
    const kinds = providers.flatMap((p) => p.kinds ?? [])
    for (const excluded of ["action", "navigation", "settings", "workbench-panel"]) {
      expect(kinds).not.toContain(excluded)
    }
    expect(providers.length).toBeGreaterThan(0)
  })

  it("scopes to the run's workspace by default and widens only when asked", async () => {
    await run("action.search.query", { query: "x" })
    expect((runGlobalSearch.mock.calls[0][1] as { activeProjectId: unknown }).activeProjectId).toBe(
      "proj1"
    )

    await run("action.search.query", { query: "x", workspaceScope: "all" })
    expect(
      (runGlobalSearch.mock.calls[1][1] as { activeProjectId: unknown }).activeProjectId
    ).toBeNull()
  })

  it("projects items and drops the icon, the callback and the raw action", async () => {
    runGlobalSearch.mockResolvedValue({
      groups: [group("session", 1)],
      totalHits: 1,
      coverage: "complete",
      truncated: false,
      tookMs: 3,
      aborted: false,
    })
    const out = (await run("action.search.query", { query: "x" })).output as {
      groups: Array<{ items: Array<Record<string, unknown>> }>
    }
    const item = out.groups[0].items[0]
    expect(item).toEqual({
      id: "session_0",
      kind: "session",
      title: "session 0",
      subtitle: "sub",
      score: 1,
      timestamp: 10,
      // The action becomes a target: its kind plus the ids on it, never `run`.
      target: { type: "open-session", sessionId: "sess_0" },
    })
    expect(JSON.stringify(out)).not.toContain("lucide")
  })

  it("caps the total across groups and says it truncated", async () => {
    runGlobalSearch.mockResolvedValue({
      groups: [group("session", 80), group("memory", 80)],
      totalHits: 160,
      coverage: "complete",
      truncated: false,
      tookMs: 3,
      aborted: false,
    })
    const out = (await run("action.search.query", { query: "x" })).output as Record<string, unknown>
    expect(out.itemCount).toBe(100)
    expect(out.truncated).toBe(true)
  })

  it("reports a per-kind limit that withheld results", async () => {
    // The engine caps each group at the per-kind limit and reports `total`.
    // Without this the output would call a partial answer complete.
    runGlobalSearch.mockResolvedValue({
      groups: [group("memory", 10, { total: 240, truncated: true })],
      totalHits: 240,
      coverage: "complete",
      truncated: false,
      tookMs: 3,
      aborted: false,
    })
    const out = (await run("action.search.query", { query: "x" })).output as {
      truncated: boolean
      totalHits: number
      groups: Array<{ total: number; truncated: boolean }>
    }
    expect(out.truncated).toBe(true)
    expect(out.totalHits).toBe(240)
    expect(out.groups[0]).toMatchObject({ total: 240, truncated: true })
  })

  it("keeps an errored provider as an errored group rather than failing the run", async () => {
    runGlobalSearch.mockResolvedValue({
      groups: [group("memory", 0, { error: "index unavailable" })],
      totalHits: 0,
      coverage: "partial",
      truncated: false,
      tookMs: 1,
      aborted: false,
    })
    const out = (await run("action.search.query", { query: "x" })).output as {
      groups: Array<{ error?: string }>
      coverage: string
    }
    expect(out.groups[0].error).toBe("index unavailable")
    expect(out.coverage).toBe("partial")
  })

  it("logs counts only, never the result set", async () => {
    runGlobalSearch.mockResolvedValue({
      groups: [group("session", 2)],
      totalHits: 2,
      coverage: "complete",
      truncated: false,
      tookMs: 3,
      aborted: false,
    })
    await run("action.search.query", { query: "secret phrase" })
    expect(logs).toHaveLength(1)
    expect(logs[0][1]).toBe("search: 1 groups, 2 items, coverage=complete")
  })

  it("threads the abort signal so a cancelled run cancels the search", async () => {
    await run("action.search.query", { query: "x" })
    expect((runGlobalSearch.mock.calls[0][2] as { signal?: unknown }).signal).toBeDefined()
  })

  it("refuses an empty query", async () => {
    await expect(run("action.search.query", { query: "  " })).rejects.toThrow(/requires 'query'/)
    expect(runGlobalSearch).not.toHaveBeenCalled()
  })
})

describe("action.search.messages", () => {
  it("scopes to the run's workspace and passes the caps through", async () => {
    await run("action.search.messages", { query: "hello", limit: 5 })
    expect(searchChatHistory.mock.calls[0][0]).toMatchObject({
      query: "hello",
      limit: 5,
      projectId: "proj1",
      includeArchived: false,
    })
  })

  it("returns the excerpt without the highlight offsets", async () => {
    searchChatHistory.mockResolvedValue({
      results: [
        {
          messageId: "m1",
          sessionId: "s1",
          sessionTitle: "Chat",
          projectId: "proj1",
          role: "user",
          createdAt: 5,
          count: 1,
          at: 0,
          snippet: { text: "…hello there…", positions: [1, 2, 3] },
          score: 2,
          archived: false,
          otherBranchCount: 0,
        },
      ],
      moreOlderHistory: true,
      indexIncomplete: true,
    })
    const out = (await run("action.search.messages", { query: "hello" })).output as {
      matches: Array<Record<string, unknown>>
      moreOlderHistory: boolean
      indexIncomplete: boolean
    }
    expect(out.matches[0]).toEqual({
      messageId: "m1",
      sessionId: "s1",
      sessionTitle: "Chat",
      projectId: "proj1",
      role: "user",
      createdAt: 5,
      score: 2,
      archived: false,
      snippet: "…hello there…",
    })
    // Two different reasons a result set is short, and they resolve differently.
    expect(out.moreOlderHistory).toBe(true)
    expect(out.indexIncomplete).toBe(true)
  })

  it("refuses an empty query", async () => {
    await expect(run("action.search.messages", { query: "" })).rejects.toThrow(/requires 'query'/)
    expect(searchChatHistory).not.toHaveBeenCalled()
  })
})
