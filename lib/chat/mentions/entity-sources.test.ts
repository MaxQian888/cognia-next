import enMessages from "@/i18n/messages/en/chat.json"
import zhMessages from "@/i18n/messages/zh-CN/chat.json"

import {
  ENTITY_MENTION_RESULT_LIMIT,
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

const EXPECTED_PREFIXES: Record<EntitySelectionKind, string> = {
  memory: "memory:",
  issue: "issue:",
  plan: "plan:",
  session: "chat:",
  artifact: "artifact:",
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
  it("registers exactly the five built-in sources", () => {
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
    expect(listEntityMentionSources()).toHaveLength(5)
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
    expect(entitySelectionFrom(candidate({ subtitle: "semantic · global" }), "body")).toEqual({
      kind: "entity",
      entityKind: "memory",
      entityId: "mem_1",
      title: "Prefers pnpm",
      // Wrapped: a memory body is often distilled from a transcript that
      // included fetched web text, so it is not necessarily the user's own
      // words (see the untrusted-content block above).
      snapshot: entitySnapshotBody("memory", "body"),
      comment: "",
      subtitle: "semantic · global",
    })
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
