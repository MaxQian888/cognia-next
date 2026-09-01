import enMessages from "@/i18n/messages/en/chat.json"
import zhMessages from "@/i18n/messages/zh-CN/chat.json"

import {
  ENTITY_MENTION_RESULT_LIMIT,
  entityMentionShortcuts,
  searchEntityMentionCandidates,
  MAX_ENTITY_SNAPSHOT_CHARS,
  __resetEntityMentionSourcesForTests,
  clampEntitySnapshot,
  entityMentionPrefixes,
  entitySelectionFrom,
  entitySnapshotBody,
  getEntityMentionSource,
  getEntityMentionSourceByPrefix,
  listEntityMentionSources,
  registerEntityMentionSource,
  unregisterEntityMentionSource,
  type EntityMentionCandidate,
  type EntityMentionSource,
} from "./entity-sources"
import { invalidateEntityMentionCaches } from "./entity-cache"
import type { EntitySelectionKind } from "@/types/artifact/artifact"

// The `@chat:` source reaches these through `await import(...)`, so the mocks
// keep Dexie out of this suite while still exercising the real `load()` body —
// which is where the exposure filter and the self-exclusion live.
const listSessionsMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ listSessions: () => listSessionsMock() }))

// The agent-team store, so `@teammate:` exercises its real `load` body.
const agentTeamState = {
  teams: {} as Record<string, unknown>,
  teammates: {} as Record<string, unknown>,
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => agentTeamState },
}))

// Same for `@msg:`, which reaches the ADR-0099 engine rather than a table.
const searchChatHistoryMock = jest.fn()
jest.mock("@/lib/chat/search/engine", () => ({
  searchChatHistory: (...args: unknown[]) => searchChatHistoryMock(...args),
}))
const loadNewestMock = jest.fn()
jest.mock("@/lib/db/chat-search-text", () => ({
  loadNewestChatSearchText: (limit: number) => loadNewestMock(limit),
}))
const bulkGetMock = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { bulkGet: (ids: string[]) => bulkGetMock(ids) } }),
}))
jest.mock("@/lib/chat/search/pending-rows", () => ({ pendingSearchRows: () => [] }))

const loadNewestResultsMock = jest.fn()
const searchResultsMock = jest.fn()
jest.mock("@/lib/db/chat-result-index", () => ({
  loadNewestChatResults: (n: number) => loadNewestResultsMock(n),
  searchChatResults: (q: string, n: number) => searchResultsMock(q, n),
}))

const EXPECTED_PREFIXES: Record<EntitySelectionKind, string> = {
  memory: "memory:",
  issue: "issue:",
  plan: "plan:",
  session: "chat:",
  message: "msg:",
  result: "result:",
  artifact: "artifact:",
  teammate: "teammate:",
}

function fakeSource(kind: string, prefix: string): EntityMentionSource {
  return {
    entityKind: kind as EntitySelectionKind,
    prefix,
    search: async () => [],
    snapshot: async () => null,
  }
}

function candidate(over: Partial<EntityMentionCandidate> = {}): EntityMentionCandidate {
  return {
    entityKind: "memory",
    id: "mem_1",
    title: "Prefers pnpm",
    searchText: "prefers pnpm",
    ...over,
  }
}

beforeEach(() => {
  __resetEntityMentionSourcesForTests()
})

describe("entity mention registry", () => {
  it("registers exactly the built-in sources", () => {
    const kinds = listEntityMentionSources().map((s) => s.entityKind)
    expect(kinds.sort()).toEqual(Object.keys(EXPECTED_PREFIXES).sort())
  })

  it("claims the documented prefix for each kind", () => {
    for (const [kind, prefix] of Object.entries(EXPECTED_PREFIXES)) {
      expect(getEntityMentionSource(kind as EntitySelectionKind)?.prefix).toBe(prefix)
      expect(getEntityMentionSourceByPrefix(prefix)?.entityKind).toBe(kind)
    }
  })

  it("exposes prefixes for the trigger detector", () => {
    expect(entityMentionPrefixes()).toEqual(
      expect.arrayContaining([{ prefix: "issue:", entityKind: "issue" }])
    )
  })

  it("refuses a duplicate kind", () => {
    expect(() => registerEntityMentionSource(fakeSource("memory", "mem2:"))).toThrow(
      /already registered/
    )
  })

  it("refuses a prefix already claimed by another kind", () => {
    expect(() => registerEntityMentionSource(fakeSource("custom", "issue:"))).toThrow(
      /already used by "issue"/
    )
  })

  it("refuses a prefix without a trailing colon", () => {
    // Without it `detectTrigger`'s `startsWith` would swallow every bare `@`
    // token beginning with those letters.
    expect(() => registerEntityMentionSource(fakeSource("custom", "custom"))).toThrow(
      /must end with ":"/
    )
  })

  it("supports registering and removing a dynamic source", () => {
    registerEntityMentionSource(fakeSource("custom", "custom:"))
    expect(getEntityMentionSourceByPrefix("custom:")).toBeDefined()
    expect(unregisterEntityMentionSource("custom" as EntitySelectionKind)).toBe(true)
    expect(getEntityMentionSourceByPrefix("custom:")).toBeUndefined()
  })

  it("re-seeds only the built-ins on reset", () => {
    registerEntityMentionSource(fakeSource("custom", "custom:"))
    __resetEntityMentionSourcesForTests()
    expect(listEntityMentionSources()).toHaveLength(Object.keys(EXPECTED_PREFIXES).length)
  })
})

describe("snapshot clamping", () => {
  it("leaves a body under the cap untouched", () => {
    expect(clampEntitySnapshot("short")).toBe("short")
  })

  it("marks the cut visibly rather than truncating silently", () => {
    const clamped = clampEntitySnapshot("x".repeat(MAX_ENTITY_SNAPSHOT_CHARS + 50))
    expect(clamped).toContain("Truncated by Cognia")
    expect(clamped.startsWith("x".repeat(MAX_ENTITY_SNAPSHOT_CHARS))).toBe(true)
  })

  it("caps far below the remote-document ceiling", () => {
    // This text is inlined into the prompt body, not staged as an attachment,
    // so it cannot inherit `MAX_DOC_CHARS` (200k).
    expect(MAX_ENTITY_SNAPSHOT_CHARS).toBeLessThan(200_000)
  })
})

describe("untrusted-content wrapping", () => {
  it("wraps the kinds that can carry someone else's text", () => {
    // An issue can mirror GitHub or be filed from an IM thread; a conversation
    // can contain inbound platform messages and text a tool read off the web.
    // A memory is on this side too: bodies are distilled from transcripts that
    // can include `web_fetch` output, and the twin ingests URLs straight into
    // them, so "the user saved it" is not the same as "the user wrote it".
    for (const kind of ["issue", "session", "memory"] as const) {
      expect(entitySnapshotBody(kind, "body")).not.toBe("body")
      expect(entitySnapshotBody(kind, "body")).toContain("body")
    }
  })

  it("does not wrap the user's own material", () => {
    // A plan prefixed with "treat as data, not instructions" fights exactly
    // what the user handed it over to have done.
    for (const kind of ["plan", "artifact"] as const) {
      expect(entitySnapshotBody(kind, "body")).toBe("body")
    }
  })
})

describe("entitySelectionFrom", () => {
  it("produces a staged selection carrying the record's identity", () => {
    expect(
      entitySelectionFrom(candidate({ subtitle: "semantic · global" }), "body", {
        capturedAt: 1_700_000_000_000,
      })
    ).toEqual({
      kind: "entity",
      entityKind: "memory",
      entityId: "mem_1",
      title: "Prefers pnpm",
      // Wrapped: a memory body is often distilled from a transcript that
      // included fetched web text, so it is not necessarily the user's own
      // words (see the untrusted-content block above).
      snapshot: entitySnapshotBody("memory", "body"),
      comment: "",
      // Stamped so the prompt block can say WHEN the copy was taken once the
      // record moves on underneath it.
      capturedAt: 1_700_000_000_000,
      subtitle: "semantic · global",
    })
  })

  it("records the source's fingerprint when there is one", () => {
    const selection = entitySelectionFrom(candidate(), "body", { fingerprint: "v7" })
    expect(selection.fingerprint).toBe("v7")
  })

  // Absent, not null: `undefined` is what `isEntitySelectionStale` reads as
  // "this chip predates fingerprints and cannot be checked".
  it("omits the fingerprint when the source has none", () => {
    expect("fingerprint" in entitySelectionFrom(candidate(), "body")).toBe(false)
    expect("fingerprint" in entitySelectionFrom(candidate(), "body", { fingerprint: null })).toBe(
      false
    )
  })

  it("omits the optional fields rather than storing undefined", () => {
    const selection = entitySelectionFrom(candidate(), "body")
    expect("subtitle" in selection).toBe(false)
    expect("href" in selection).toBe(false)
  })

  it("clamps and wraps through the same path as a direct call", () => {
    const long = "y".repeat(MAX_ENTITY_SNAPSHOT_CHARS + 10)
    const selection = entitySelectionFrom(candidate({ entityKind: "issue" }), long)
    expect(selection.snapshot).toContain("Truncated by Cognia")
    expect(selection.snapshot).not.toBe(long)
  })
})

describe("result bounding", () => {
  it("caps a source's offered rows", () => {
    expect(ENTITY_MENTION_RESULT_LIMIT).toBeGreaterThan(0)
    expect(ENTITY_MENTION_RESULT_LIMIT).toBeLessThanOrEqual(50)
  })
})

describe("i18n catalogue coverage", () => {
  // The popover and the chip both read `entityKinds.<kind>` as a DYNAMIC key
  // (`t(`entityKinds.${kind}`)`), which `pnpm lint:i18n` cannot see. Without
  // this, adding a sixth source would ship a row labelled with its raw key.
  const kinds = Object.keys(EXPECTED_PREFIXES) as EntitySelectionKind[]

  it.each(["en", "zh-CN"])("has a %s label for every registered kind", (locale) => {
    const messages = locale === "en" ? enMessages : zhMessages
    const catalogue = (
      messages as unknown as {
        composer: { popover: { entityKinds: Record<string, string> } }
      }
    ).composer.popover.entityKinds
    for (const kind of kinds) {
      expect(typeof catalogue[kind]).toBe("string")
      expect(catalogue[kind].length).toBeGreaterThan(0)
    }
  })

  it("has no label for a kind that is not registered", () => {
    const catalogue = (
      enMessages as unknown as {
        composer: { popover: { entityKinds: Record<string, string> } }
      }
    ).composer.popover.entityKinds
    expect(Object.keys(catalogue).sort()).toEqual([...kinds].sort())
  })
})

describe("searchEntityMentionCandidates", () => {
  beforeEach(() => {
    invalidateEntityMentionCaches()
  })

  function listSource(rows: EntityMentionCandidate[]): EntityMentionSource & { calls: number } {
    const source = {
      calls: 0,
      entityKind: "memory" as EntitySelectionKind,
      prefix: "memory:",
      async load() {
        source.calls++
        return rows
      },
      async snapshot() {
        return null
      },
    }
    return source
  }

  it("filters the cached list instead of re-reading per keystroke", async () => {
    const source = listSource([
      candidate({ id: "1", title: "alpha", searchText: "alpha" }),
      candidate({ id: "2", title: "beta", searchText: "beta" }),
    ])
    expect((await searchEntityMentionCandidates(source, "al", {})).map((c) => c.id)).toEqual(["1"])
    expect((await searchEntityMentionCandidates(source, "alp", {})).map((c) => c.id)).toEqual(["1"])
    expect((await searchEntityMentionCandidates(source, "be", {})).map((c) => c.id)).toEqual(["2"])
    expect(source.calls).toBe(1)
  })

  it("returns everything for an empty query", async () => {
    const source = listSource([candidate({ id: "1" }), candidate({ id: "2" })])
    expect(await searchEntityMentionCandidates(source, "", {})).toHaveLength(2)
  })

  it("matches case-insensitively", async () => {
    const source = listSource([candidate({ id: "1", searchText: "readme notes" })])
    expect(await searchEntityMentionCandidates(source, "README", {})).toHaveLength(1)
  })

  it("caps the offered rows at the shared limit", async () => {
    const rows = Array.from({ length: ENTITY_MENTION_RESULT_LIMIT + 5 }, (_, i) =>
      candidate({ id: String(i), searchText: "x" })
    )
    expect(await searchEntityMentionCandidates(listSource(rows), "x", {})).toHaveLength(
      ENTITY_MENTION_RESULT_LIMIT
    )
  })

  it("lets a query-driven source own its own query", async () => {
    const search = jest.fn(async () => [candidate({ id: "engine" })])
    const source: EntityMentionSource = {
      entityKind: "memory",
      prefix: "memory:",
      search,
      snapshot: async () => null,
    }
    expect((await searchEntityMentionCandidates(source, "q", {})).map((c) => c.id)).toEqual([
      "engine",
    ])
    expect(search).toHaveBeenCalledWith("q", {})
  })
})

describe("source registration contract", () => {
  afterEach(() => {
    __resetEntityMentionSourcesForTests()
  })

  it("refuses a source that can neither list nor search", () => {
    expect(() =>
      registerEntityMentionSource({
        entityKind: "custom" as EntitySelectionKind,
        prefix: "custom:",
        snapshot: async () => null,
      })
    ).toThrow(/load\(\) or search\(\)/)
  })
})

describe("@chat: candidates", () => {
  beforeEach(() => {
    invalidateEntityMentionCaches()
    listSessionsMock.mockReset()
  })

  const session = (over: Record<string, unknown>) => ({
    id: "s",
    title: "T",
    updatedAt: 0,
    ...over,
  })

  async function chatCandidates(ctx: Parameters<typeof searchEntityMentionCandidates>[2]) {
    const source = getEntityMentionSourceByPrefix("chat:")!
    return searchEntityMentionCandidates(source, "", ctx)
  }

  // A subagent's inner transcript, a workbench aside and a workflow-editor
  // session are reachable from the turn that owns them, never from a list.
  // Offering them here made the panel disagree with every other surface.
  it.each([
    ["subagent", { kind: "subagent" }],
    ["resource-workbench aside", { kind: "resource-workbench" }],
    ["workflow-editor", { kind: "workflow-editor" }],
    ["embedded", { visibility: "embedded" }],
  ])("never offers a %s session", async (_label, over) => {
    listSessionsMock.mockResolvedValue([
      session({ id: "hidden", ...over }),
      session({ id: "plain" }),
    ])
    expect((await chatCandidates({})).map((c) => c.id)).toEqual(["plain"])
  })

  it("never offers the conversation being composed in", async () => {
    listSessionsMock.mockResolvedValue([session({ id: "here" }), session({ id: "other" })])
    expect((await chatCandidates({ sessionId: "here" })).map((c) => c.id)).toEqual(["other"])
  })

  it("keeps a session with no workspace stamp when a workspace is active", async () => {
    listSessionsMock.mockResolvedValue([
      session({ id: "legacy" }),
      session({ id: "mine", projectId: "p" }),
      session({ id: "theirs", projectId: "q" }),
    ])
    expect((await chatCandidates({ projectId: "p" })).map((c) => c.id)).toEqual(["legacy", "mine"])
  })
})

describe("@teammate: candidates", () => {
  const source = () => getEntityMentionSourceByPrefix("teammate:")!

  const squad = (over: Record<string, unknown> = {}) => ({
    id: "sq1",
    name: "Review Crew",
    projectId: "p",
    ...over,
  })
  const mate = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    teamId: "sq1",
    name: "Reviewer",
    role: "teammate",
    description: "reads every diff",
    config: { specialization: "security" },
    ...over,
  })

  beforeEach(() => {
    invalidateEntityMentionCaches()
    agentTeamState.teams = { sq1: squad() }
    agentTeamState.teammates = { m1: mate() }
  })

  /**
   * The registry's rule is that a mention must produce text a model can read.
   * A teammate is a role with a description, a specialization and a spawn
   * prompt, so `@teammate:Reviewer` means "answer the way the reviewer would".
   */
  it("offers the roster with its Squad on the second line", async () => {
    const rows = await searchEntityMentionCandidates(source(), "", { projectId: "p" })
    expect(rows).toEqual([
      expect.objectContaining({
        entityKind: "teammate",
        id: "m1",
        title: "Reviewer",
        // Two Squads routinely both have a "Reviewer".
        subtitle: "Review Crew · security",
        href: "/squads?id=sq1",
      }),
    ])
  })

  it("keeps a Squad that names no workspace, and drops another workspace's", async () => {
    agentTeamState.teams = {
      sq1: squad(),
      shared: squad({ id: "shared", name: "Shared", projectId: undefined }),
      other: squad({ id: "other", name: "Other", projectId: "q" }),
    }
    agentTeamState.teammates = {
      m1: mate(),
      m2: mate({ id: "m2", teamId: "shared" }),
      m3: mate({ id: "m3", teamId: "other" }),
    }
    const rows = await searchEntityMentionCandidates(source(), "", { projectId: "p" })
    expect(rows.map((r) => r.id).sort()).toEqual(["m1", "m2"])
  })

  it("drops a teammate whose Squad is gone", async () => {
    agentTeamState.teams = {}
    expect(await searchEntityMentionCandidates(source(), "", {})).toEqual([])
  })

  it("snapshots what the teammate is, longest field last", async () => {
    agentTeamState.teammates = { m1: mate({ spawnPrompt: "Be exacting." }) }
    const body = await source().snapshot({
      entityKind: "teammate",
      id: "m1",
      title: "Reviewer",
      searchText: "",
    })
    expect(body).toBe("Reviewer (security)\n\nreads every diff\n\nBe exacting.")
  })

  it("reports a deleted teammate as gone rather than empty", async () => {
    agentTeamState.teammates = {}
    const candidate = { entityKind: "teammate" as const, id: "m1", title: "R", searchText: "" }
    expect(await source().snapshot(candidate)).toBeNull()
    expect(await source().fingerprint!(candidate)).toBeNull()
  })

  /**
   * A teammate row carries no `updatedAt`, so the fingerprint is the body
   * itself: the fields a snapshot reads are exactly the ones whose change must
   * make a staged chip stale.
   */
  it("goes stale when the prompt changes", async () => {
    const candidate = { entityKind: "teammate" as const, id: "m1", title: "R", searchText: "" }
    const before = await source().fingerprint!(candidate)
    agentTeamState.teammates = { m1: mate({ spawnPrompt: "Now be lenient." }) }
    expect(await source().fingerprint!(candidate)).not.toBe(before)
  })
})

describe("@msg: candidates", () => {
  const source = () => getEntityMentionSourceByPrefix("msg:")!

  beforeEach(() => {
    invalidateEntityMentionCaches()
    searchChatHistoryMock.mockReset()
    loadNewestMock.mockReset()
    bulkGetMock.mockReset()
    searchChatHistoryMock.mockResolvedValue({
      results: [],
      moreOlderHistory: false,
      indexIncomplete: false,
    })
    loadNewestMock.mockResolvedValue([])
    bulkGetMock.mockResolvedValue([])
  })

  const hit = (over: Record<string, unknown> = {}) => ({
    messageId: "m1",
    sessionId: "s1",
    sessionTitle: "Restacking",
    projectId: "p",
    role: "assistant",
    createdAt: Date.UTC(2026, 7, 20),
    count: 1,
    at: 0,
    snippet: { text: "run /stack restack", positions: [] },
    score: 1,
    archived: false,
    otherBranchCount: 0,
    ...over,
  })

  // The point of the source: `@chat:` could only ever match a conversation by
  // its TITLE, and the tuned cross-conversation index was already there.
  it("searches message CONTENT through the ADR-0099 engine", async () => {
    searchChatHistoryMock.mockResolvedValue({ results: [hit()], moreOlderHistory: false })
    const rows = await searchEntityMentionCandidates(source(), "restack", { projectId: "p" })
    expect(searchChatHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "restack", projectId: "p", collapseBySession: false }),
      expect.objectContaining({ pendingRows: expect.any(Function) })
    )
    expect(rows).toHaveLength(1)
  })

  it("identifies a candidate by conversation AND message", async () => {
    searchChatHistoryMock.mockResolvedValue({ results: [hit()], moreOlderHistory: false })
    const [row] = await searchEntityMentionCandidates(source(), "restack", {})
    expect(row.id).toBe("s1#m1")
    expect(row.entityKind).toBe("message")
  })

  it("titles the row by conversation and subtitles it with the excerpt", async () => {
    searchChatHistoryMock.mockResolvedValue({ results: [hit()], moreOlderHistory: false })
    const [row] = await searchEntityMentionCandidates(source(), "restack", {})
    expect(row.title).toBe("Restacking")
    expect(row.subtitle).toContain("assistant")
    expect(row.subtitle).toContain("run /stack restack")
  })

  // A conversation link would land on the tail; the reference is to one turn.
  it("links to the message permalink, not to the conversation", async () => {
    searchChatHistoryMock.mockResolvedValue({ results: [hit()], moreOlderHistory: false })
    const [row] = await searchEntityMentionCandidates(source(), "restack", {})
    expect(row.href).toBe("/?session=s1&message=m1")
  })

  // Below the floor the engine would scan the whole resident haystack for one
  // letter — the same floor ⌘K applies.
  it("does not reach the engine for a one-character query", async () => {
    expect(await searchEntityMentionCandidates(source(), "r", {})).toEqual([])
    expect(searchChatHistoryMock).not.toHaveBeenCalled()
  })

  // `searchChatHistory` returns nothing for an empty query by design, so
  // "recent messages" has to come from the index directly.
  it("offers the newest messages for an empty query", async () => {
    loadNewestMock.mockResolvedValue([
      { messageId: "m9", sessionId: "s9", projectId: "p", role: "user", createdAt: 0, text: "hi" },
    ])
    bulkGetMock.mockResolvedValue([{ id: "s9", title: "Nine" }])
    const rows = await searchEntityMentionCandidates(source(), "", {})
    expect(searchChatHistoryMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "s9#m9", title: "Nine" })
  })

  it("keeps the newest list inside the active workspace", async () => {
    loadNewestMock.mockResolvedValue([
      { messageId: "a", sessionId: "sa", projectId: "p", role: "user", createdAt: 0, text: "x" },
      { messageId: "b", sessionId: "sb", projectId: "q", role: "user", createdAt: 0, text: "x" },
      // Pre-isolation rows carry no workspace stamp and must stay reachable.
      { messageId: "c", sessionId: "sc", projectId: "", role: "user", createdAt: 0, text: "x" },
    ])
    bulkGetMock.mockResolvedValue([])
    const rows = await searchEntityMentionCandidates(source(), "", { projectId: "p" })
    expect(rows.map((r) => r.id)).toEqual(["sa#a", "sc#c"])
  })

  it("falls back to the session id when a conversation has no title", async () => {
    loadNewestMock.mockResolvedValue([
      { messageId: "m", sessionId: "s", projectId: "", role: "user", createdAt: 0, text: "x" },
    ])
    bulkGetMock.mockResolvedValue([undefined])
    const [row] = await searchEntityMentionCandidates(source(), "", {})
    expect(row.title).toBe("s")
  })

  it("caps the offered rows", async () => {
    searchChatHistoryMock.mockResolvedValue({
      results: Array.from({ length: 30 }, (_, i) => hit({ messageId: `m${i}` })),
      moreOlderHistory: false,
    })
    const rows = await searchEntityMentionCandidates(source(), "restack", {})
    expect(searchChatHistoryMock.mock.calls[0][0].limit).toBe(ENTITY_MENTION_RESULT_LIMIT)
    expect(rows).toHaveLength(30)
  })
})

describe("untrusted wrapping for a message", () => {
  // A `@msg:` body deliberately carries the tool OUTPUT the transcript snapshot
  // drops — the part most likely to be text the web wrote.
  it("wraps a referenced message", () => {
    expect(entitySnapshotBody("message", "whatever a tool returned")).toContain(
      "whatever a tool returned"
    )
    expect(entitySnapshotBody("message", "x")).not.toBe("x")
  })
})

describe("@result: candidates", () => {
  const source = () => getEntityMentionSourceByPrefix("result:")!

  const resultRow = (over: Record<string, unknown> = {}) => ({
    resultId: "m1:1",
    messageId: "m1",
    sessionId: "s1",
    projectId: "p",
    createdAt: 1_000,
    kind: "tool",
    toolName: "Read",
    title: "/tmp/a.txt",
    preview: "the file body",
    bytes: 2_400,
    searchText: "read /tmp/a.txt the file body",
    ...over,
  })

  beforeEach(() => {
    invalidateEntityMentionCaches()
    loadNewestResultsMock.mockReset().mockResolvedValue([])
    searchResultsMock.mockReset().mockResolvedValue([])
  })

  // The empty query IS the `^` case: the most recent results, by index walk.
  it("lists the newest results for an empty query", async () => {
    loadNewestResultsMock.mockResolvedValue([resultRow()])
    const rows = await searchEntityMentionCandidates(source(), "", {})
    expect(loadNewestResultsMock).toHaveBeenCalled()
    expect(searchResultsMock).not.toHaveBeenCalled()
    expect(rows[0]).toMatchObject({ entityKind: "result", id: "m1:1", title: "/tmp/a.txt" })
  })

  it("searches the index for a non-empty query", async () => {
    searchResultsMock.mockResolvedValue([resultRow()])
    await searchEntityMentionCandidates(source(), "grep", {})
    expect(searchResultsMock).toHaveBeenCalledWith("grep", expect.any(Number))
    expect(loadNewestResultsMock).not.toHaveBeenCalled()
  })

  // A row says what it is about to inline; a 2 MB file read and a one-line
  // command look identical without it.
  it("says the tool, the size and the excerpt on the row", async () => {
    loadNewestResultsMock.mockResolvedValue([resultRow()])
    const [row] = await searchEntityMentionCandidates(source(), "", {})
    expect(row.subtitle).toContain("Read")
    expect(row.subtitle).toContain("2.4 kB")
    expect(row.subtitle).toContain("the file body")
  })

  it("links back to the message that produced it", async () => {
    loadNewestResultsMock.mockResolvedValue([resultRow()])
    const [row] = await searchEntityMentionCandidates(source(), "", {})
    expect(row.href).toBe("/?session=s1&message=m1")
  })

  it("keeps the list inside the active workspace, sparing pre-isolation rows", async () => {
    loadNewestResultsMock.mockResolvedValue([
      resultRow({ resultId: "a", projectId: "p" }),
      resultRow({ resultId: "b", projectId: "q" }),
      resultRow({ resultId: "c", projectId: "" }),
    ])
    const rows = await searchEntityMentionCandidates(source(), "", { projectId: "p" })
    expect(rows.map((r) => r.id)).toEqual(["a", "c"])
  })

  it("caps the offered rows", async () => {
    loadNewestResultsMock.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => resultRow({ resultId: `r${i}` }))
    )
    expect(await searchEntityMentionCandidates(source(), "", {})).toHaveLength(
      ENTITY_MENTION_RESULT_LIMIT
    )
  })
})

describe("shortcut characters", () => {
  afterEach(() => {
    __resetEntityMentionSourcesForTests()
  })

  it("exposes the result source's shortcut to the trigger detector", () => {
    expect(entityMentionShortcuts()).toEqual([
      { shortcut: "^", prefix: "result:", entityKind: "result" },
    ])
  })

  it("refuses a shortcut that is not one character", () => {
    expect(() =>
      registerEntityMentionSource({
        ...fakeSource("custom", "custom:"),
        shortcut: "^^",
      })
    ).toThrow(/one character/)
  })

  // `@` is the namespace root; `!` and `#` are first-line modes that claim
  // their whole line and would swallow the shortcut's query.
  it.each([["@"], ["!"], ["#"], ["/"]])("refuses the reserved character %s", (char) => {
    expect(() =>
      registerEntityMentionSource({ ...fakeSource("custom", "custom:"), shortcut: char })
    ).toThrow(/one character/)
  })

  it("refuses a shortcut another source already claims", () => {
    expect(() =>
      registerEntityMentionSource({ ...fakeSource("custom", "custom:"), shortcut: "^" })
    ).toThrow(/already used by "result"/)
  })

  it("allows a source with no shortcut at all", () => {
    expect(() => registerEntityMentionSource(fakeSource("custom", "custom:"))).not.toThrow()
  })
})
