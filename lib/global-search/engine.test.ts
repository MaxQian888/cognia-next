import {
  ALL_SCOPE_GROUP_LIMIT,
  ALL_SCOPE_MESSAGE_LIMIT,
  SCOPED_GROUP_LIMIT,
  SUGGEST_LIMIT,
  orderGroups,
  runGlobalSearch,
  runGlobalSearchSuggestions,
  worstCoverage,
} from "./engine"
import { parseGlobalSearchQuery } from "./query-parser"
import { __resetGlobalSearchRegistryForTesting, registerGlobalSearchProvider } from "./registry"
import type {
  GlobalSearchContext,
  GlobalSearchGroup,
  GlobalSearchItem,
  GlobalSearchKind,
  GlobalSearchProvider,
} from "./types"

const ctx = (scope: GlobalSearchContext["scope"] = "all"): GlobalSearchContext => ({
  t: (k) => k,
  locale: "en",
  platform: "web",
  isTauri: false,
  now: 1000,
  activeProjectId: null,
  activeSessionId: null,
  sessions: [],
  workspaces: [],
  scope,
  host: {
    reachableSettingsSections: new Set(),
    recorderAvailable: false,
    theme: "light",
    hasApiKey: false,
    pluginQuickActions: [],
    workbenchPanels: [],
  },
})

const item = (kind: GlobalSearchKind, id: string, score: number): GlobalSearchItem => ({
  id: `${kind}:${id}`,
  kind,
  title: id,
  score,
  action: { type: "navigate", href: `/${id}` },
})

const provider = (
  kind: GlobalSearchKind,
  items: GlobalSearchItem[],
  over: Partial<GlobalSearchProvider> = {}
): GlobalSearchProvider => ({
  id: `p.${kind}`,
  kind,
  search: () => ({ items }),
  ...over,
})

describe("runGlobalSearch", () => {
  beforeEach(() => __resetGlobalSearchRegistryForTesting())

  it("runs registry providers for the scope, sorts items, drops empty groups", async () => {
    registerGlobalSearchProvider(
      provider("session", [item("session", "b", 0.2), item("session", "a", 0.9)])
    )
    registerGlobalSearchProvider(provider("skill", []))
    registerGlobalSearchProvider(provider("action", [item("action", "x", 0.5)]))
    const out = await runGlobalSearch(parseGlobalSearchQuery("a"), ctx("all"), { now: () => 5 })
    // session's 0.9 best score pulls it ahead of the lower-priority-number action group.
    expect(out.groups.map((g) => g.kind)).toEqual(["session", "action"])
    expect(out.groups[0]!.items.map((i) => i.title)).toEqual(["a", "b"])
    expect(out.totalHits).toBe(3)
    expect(out.coverage).toBe("complete")
    expect(out.aborted).toBe(false)
    expect(out.tookMs).toBe(0)
  })

  it("respects the tab scope and in: filters when picking providers", async () => {
    const seen: string[] = []
    for (const kind of ["session", "message", "skill"] as const) {
      registerGlobalSearchProvider(
        provider(kind, [item(kind, "z", 1)], {
          search: () => {
            seen.push(kind)
            return { items: [item(kind, "z", 1)] }
          },
        })
      )
    }
    await runGlobalSearch(parseGlobalSearchQuery("z"), ctx("chats"))
    expect(seen.sort()).toEqual(["message", "session"])
    seen.length = 0
    await runGlobalSearch(parseGlobalSearchQuery("in:skills z"), ctx("chats"))
    expect(seen).toEqual(["skill"])
    seen.length = 0
    // Prefix scope wins over the tab, and the provider sees the effective scope.
    const commandsProvider = provider("action", [item("action", "z", 1)], {
      search: ({ ctx: c }) => {
        seen.push(`action@${c.scope}`)
        return { items: [item("action", "z", 1)] }
      },
    })
    registerGlobalSearchProvider(commandsProvider)
    await runGlobalSearch(parseGlobalSearchQuery(">z"), ctx("people"))
    expect(seen).toEqual(["action@commands"])
  })

  it("applies per-scope group limits and marks truncation", async () => {
    const many = Array.from({ length: 40 }, (_, i) => item("session", `s${i}`, i / 40))
    const messages = Array.from({ length: 40 }, (_, i) => item("message", `m${i}`, i / 40))
    const providers = [provider("session", many), provider("message", messages)]
    const all = await runGlobalSearch(parseGlobalSearchQuery("s"), ctx("all"), { providers })
    const sessionGroup = all.groups.find((g) => g.kind === "session")!
    const messageGroup = all.groups.find((g) => g.kind === "message")!
    expect(sessionGroup.items).toHaveLength(ALL_SCOPE_GROUP_LIMIT)
    expect(messageGroup.items).toHaveLength(ALL_SCOPE_MESSAGE_LIMIT)
    expect(sessionGroup.truncated).toBe(true)
    expect(sessionGroup.total).toBe(40)
    const scoped = await runGlobalSearch(parseGlobalSearchQuery("s"), ctx("chats"), { providers })
    expect(scoped.groups.find((g) => g.kind === "session")!.items).toHaveLength(SCOPED_GROUP_LIMIT)
    const raised = await runGlobalSearch(parseGlobalSearchQuery("s"), ctx("chats"), {
      providers,
      limit: 100,
    })
    expect(raised.groups.find((g) => g.kind === "session")!.items).toHaveLength(40)
    expect(raised.groups.find((g) => g.kind === "session")!.truncated).toBe(false)
  })

  it("honours provider-reported total / truncated / coverage", async () => {
    const providers = [
      provider("message", [item("message", "a", 1)], {
        search: () => ({
          items: [item("message", "a", 1)],
          total: 99,
          truncated: true,
          coverage: "indexing",
        }),
      }),
      provider("session", [item("session", "b", 1)], {
        search: () => ({ items: [item("session", "b", 1)], coverage: "partial" }),
      }),
    ]
    const out = await runGlobalSearch(parseGlobalSearchQuery("a"), ctx(), { providers })
    expect(out.coverage).toBe("indexing")
    expect(out.totalHits).toBe(100)
    expect(out.groups.find((g) => g.kind === "message")!.truncated).toBe(true)
  })

  it("keeps an errored group instead of failing the run", async () => {
    const providers = [
      provider("session", [], {
        search: () => {
          throw new Error("dexie down")
        },
      }),
      provider("action", [item("action", "ok", 1)]),
    ]
    const out = await runGlobalSearch(parseGlobalSearchQuery("x"), ctx(), { providers })
    expect(out.groups.map((g) => g.kind)).toEqual(["action", "session"])
    expect(out.groups[1]!.error).toBe("dexie down")
    expect(out.groups[1]!.coverage).toBe("partial")
    const nonError = [
      provider("session", [], {
        search: () => {
          throw "raw"
        },
      }),
    ]
    const out2 = await runGlobalSearch(parseGlobalSearchQuery("x"), ctx(), { providers: nonError })
    expect(out2.groups[0]!.error).toBe("raw")
  })

  it("propagates abort to providers and drops their errors", async () => {
    const controller = new AbortController()
    let sawAbort = false
    const providers = [
      provider("session", [], {
        search: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              sawAbort = true
              reject(new Error("aborted"))
            })
          }),
      }),
    ]
    const run = runGlobalSearch(parseGlobalSearchQuery("x"), ctx(), {
      providers,
      signal: controller.signal,
    })
    controller.abort()
    const out = await run
    expect(sawAbort).toBe(true)
    expect(out.aborted).toBe(true)
    expect(out.groups).toEqual([])
    // Already-aborted signal short-circuits too.
    const pre = new AbortController()
    pre.abort()
    const out2 = await runGlobalSearch(parseGlobalSearchQuery("x"), ctx(), {
      providers: [provider("action", [item("action", "a", 1)])],
      signal: pre.signal,
    })
    expect(out2.aborted).toBe(true)
  })

  it("re-ranks groups by best score in the all scope only", () => {
    const g = (kind: GlobalSearchKind, best: number): GlobalSearchGroup => ({
      kind,
      providerId: kind,
      items: [],
      bestScore: best,
      total: 0,
      truncated: false,
      coverage: "complete",
    })
    // action (prio 0, score 0.1) vs session (prio 1, score 1): session pulls ahead by 3 slots.
    expect(orderGroups([g("action", 0.1), g("session", 1)], true).map((x) => x.kind)).toEqual([
      "session",
      "action",
    ])
    expect(orderGroups([g("session", 1), g("action", 0.1)], false).map((x) => x.kind)).toEqual([
      "action",
      "session",
    ])
    // Same kind from two providers: provider id breaks the tie.
    expect(
      orderGroups(
        [
          { ...g("skill", 0.5), providerId: "b" },
          { ...g("skill", 0.5), providerId: "a" },
        ],
        true
      ).map((x) => x.providerId)
    ).toEqual(["a", "b"])
  })

  it("worstCoverage picks the weaker of two", () => {
    expect(worstCoverage("complete", "partial")).toBe("partial")
    expect(worstCoverage("indexing", "partial")).toBe("indexing")
    expect(worstCoverage("complete", "complete")).toBe("complete")
  })
})

describe("runGlobalSearchSuggestions", () => {
  beforeEach(() => __resetGlobalSearchRegistryForTesting())

  it("collects suggest() from providers in scope, static order, sliced", async () => {
    registerGlobalSearchProvider(
      provider("session", [], {
        suggest: () =>
          Array.from({ length: SUGGEST_LIMIT + 2 }, (_, i) => item("session", `s${i}`, 1)),
      })
    )
    registerGlobalSearchProvider(
      provider("action", [], { suggest: () => [item("action", "new", 1)] })
    )
    registerGlobalSearchProvider(provider("skill", [], { suggest: () => [] }))
    registerGlobalSearchProvider(provider("team", [])) // no suggest
    registerGlobalSearchProvider(
      provider("memory", [], {
        suggest: () => {
          throw new Error("no")
        },
      })
    )
    const groups = await runGlobalSearchSuggestions(ctx("all"))
    expect(groups.map((g) => g.kind)).toEqual(["action", "session"])
    expect(groups[1]!.items).toHaveLength(SUGGEST_LIMIT)
    expect(groups[1]!.truncated).toBe(true)
    expect(groups[1]!.total).toBe(SUGGEST_LIMIT + 2)
    const scoped = await runGlobalSearchSuggestions(ctx("commands"))
    expect(scoped.map((g) => g.kind)).toEqual(["action"])
  })

  it("accepts explicit providers and an aborted signal", async () => {
    const pre = new AbortController()
    pre.abort()
    const groups = await runGlobalSearchSuggestions(ctx(), {
      providers: [provider("action", [], { suggest: () => [item("action", "a", 1)] })],
      signal: pre.signal,
    })
    expect(groups).toHaveLength(1)
    const live = new AbortController()
    const groups2 = await runGlobalSearchSuggestions(ctx(), {
      providers: [provider("action", [], { suggest: () => [item("action", "a", 1)] })],
      signal: live.signal,
    })
    expect(groups2).toHaveLength(1)
  })
})
