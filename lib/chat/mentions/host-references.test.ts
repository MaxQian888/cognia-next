import type { HostProfile } from "@/lib/platform/capabilities"

import type { EntityMentionCandidate, LocalHistoryReference } from "./entity-sources"
import {
  SESSION_REFERENCE_QUERY_MAX_CHARS,
  SESSION_REFERENCE_SEARCH_COMMAND,
  SESSION_REFERENCE_SNAPSHOT_COMMAND,
  SESSION_REFERENCE_SNAPSHOT_MAX_IDS,
  __setHostHistoryReferenceClientForTests,
  candidateFromWire,
  createHostHistoryReferenceClient,
  fingerprintHistoryReference,
  historyReferencesLiveOnHost,
  searchHistoryReferences,
  snapshotHistoryReference,
  type HostHistoryReferenceClient,
} from "./host-references"

let profile: HostProfile = "desktop"
jest.mock("@/lib/platform/capabilities", () => ({
  detectHostProfile: () => profile,
}))

function transportAnswering(answer: (name: string, args: Record<string, unknown>) => unknown) {
  const call = jest.fn(async (name: string, args?: Record<string, unknown>) =>
    answer(name, args ?? {})
  )
  return { call, client: createHostHistoryReferenceClient(async () => ({ call }) as never) }
}

function row(id: string): EntityMentionCandidate {
  return { entityKind: "message", id, title: id, searchText: id }
}

function fakeLocal(over: Partial<LocalHistoryReference> = {}): {
  [K in keyof LocalHistoryReference]: jest.Mock
} {
  return {
    search: jest.fn(async () => [row("local")]),
    snapshot: jest.fn(async () => "local body"),
    fingerprint: jest.fn(async () => "local-fp"),
    ...over,
  } as never
}

function fakeHost(over: Partial<HostHistoryReferenceClient> = {}): {
  [K in keyof HostHistoryReferenceClient]: jest.Mock
} {
  return {
    search: jest.fn(async () => [row("host")]),
    read: jest.fn(async (_kind: string, id: string) => ({
      id,
      fingerprint: "host-fp",
      body: "host body",
    })),
    fingerprint: jest.fn(async () => "host-fp"),
    ...over,
  } as never
}

afterEach(() => {
  profile = "desktop"
  __setHostHistoryReferenceClientForTests(null)
})

describe("historyReferencesLiveOnHost", () => {
  it.each([
    ["mobile-companion", true],
    ["cloud-companion", true],
    // The host itself, and a browser whose own database IS its history.
    ["desktop", false],
    ["headless", false],
    ["web-standalone", false],
  ] as const)("%s → %s", (name, expected) => {
    expect(historyReferencesLiveOnHost(name)).toBe(expected)
  })
})

describe("the host client", () => {
  it("asks for one kind with the composer's place, and rebuilds the rows", async () => {
    const { call, client } = transportAnswering(() => ({
      candidates: [
        {
          id: "s1#m1",
          title: "Release Prep",
          subtitle: "user · 2026-09-01 · Tag It",
          href: "/?session=s1&message=m1",
          sourceSessionId: "s1",
        },
      ],
    }))
    const rows = await client.search("message", "tag", { projectId: "p1", sessionId: null })
    expect(call).toHaveBeenCalledWith(SESSION_REFERENCE_SEARCH_COMMAND, {
      kind: "message",
      query: "tag",
      projectId: "p1",
    })
    expect(rows).toEqual([
      {
        entityKind: "message",
        id: "s1#m1",
        title: "Release Prep",
        subtitle: "user · 2026-09-01 · Tag It",
        href: "/?session=s1&message=m1",
        sourceSessionId: "s1",
        searchText: "release prep user · 2026-09-01 · tag it",
      },
    ])
  })

  it("never sends more query than the contract accepts", async () => {
    const { call, client } = transportAnswering(() => ({ candidates: [] }))
    await client.search("result", "x".repeat(SESSION_REFERENCE_QUERY_MAX_CHARS + 20), {})
    expect(call.mock.calls[0]![1]!.query).toHaveLength(SESSION_REFERENCE_QUERY_MAX_CHARS)
  })

  it("keeps the words a prompt row can put back", async () => {
    const { client } = transportAnswering(() => ({
      candidates: [{ id: "s1#m2", title: "ship it", insertText: "ship it\nnow" }],
    }))
    const [prompt] = await client.search("prompt", "", {})
    expect(prompt).toMatchObject({ entityKind: "prompt", insertText: "ship it\nnow" })
  })

  it.each([
    ["no candidate list", {}],
    ["a row with no title", { candidates: [{ id: "x" }] }],
    ["a bare array", []],
  ])("refuses %s rather than showing an empty list", async (_label, answer) => {
    const { client } = transportAnswering(() => answer)
    await expect(client.search("message", "q", {})).rejects.toThrow(/malformed/)
  })

  it("reads one record with its body", async () => {
    const { call, client } = transportAnswering(() => ({
      records: [{ id: "m1:0", fingerprint: "fp", body: "Result of grep:\nhit" }],
    }))
    await expect(client.read("result", "m1:0")).resolves.toEqual({
      id: "m1:0",
      fingerprint: "fp",
      body: "Result of grep:\nhit",
    })
    expect(call).toHaveBeenCalledWith(SESSION_REFERENCE_SNAPSHOT_COMMAND, {
      kind: "result",
      ids: ["m1:0"],
      withBody: true,
    })
  })

  it("treats a record the host skipped as a failed read, not a deleted one", async () => {
    const { client } = transportAnswering(() => ({ records: [] }))
    await expect(client.read("result", "m1:0")).rejects.toThrow(/did not answer/)
  })

  describe("fingerprints", () => {
    it("checks everything asked for in one turn with one request per kind", async () => {
      const { call, client } = transportAnswering((_name, args) => ({
        records: (args.ids as string[]).map((id) => ({
          id,
          fingerprint: id === "gone" ? null : `${args.kind}:${id}`,
        })),
      }))
      const answers = await Promise.all([
        client.fingerprint("message", "a"),
        client.fingerprint("message", "b"),
        client.fingerprint("message", "a"),
        client.fingerprint("message", "gone"),
        client.fingerprint("prompt", "a"),
      ])
      expect(answers).toEqual(["message:a", "message:b", "message:a", null, "prompt:a"])
      expect(call).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenCalledWith(SESSION_REFERENCE_SNAPSHOT_COMMAND, {
        kind: "message",
        ids: ["a", "b", "gone"],
        withBody: false,
      })
      expect(call).toHaveBeenCalledWith(SESSION_REFERENCE_SNAPSHOT_COMMAND, {
        kind: "prompt",
        ids: ["a"],
        withBody: false,
      })
    })

    // Each real caller reaches the client after its own `await import(...)`,
    // and those continuations land a different number of ticks apart.
    it("still shares one request when callers arrive after awaits of different depth", async () => {
      const { call, client } = transportAnswering((_name, args) => ({
        records: (args.ids as string[]).map((id) => ({ id, fingerprint: id })),
      }))
      const afterTicks = async (ticks: number, id: string) => {
        for (let i = 0; i < ticks; i++) await Promise.resolve()
        return client.fingerprint("message", id)
      }
      await expect(
        Promise.all([afterTicks(1, "a"), afterTicks(5, "b"), afterTicks(12, "c")])
      ).resolves.toEqual(["a", "b", "c"])
      expect(call).toHaveBeenCalledTimes(1)
    })

    it("splits a batch at the contract's id limit", async () => {
      const { call, client } = transportAnswering((_name, args) => ({
        records: (args.ids as string[]).map((id) => ({ id, fingerprint: id })),
      }))
      const ids = Array.from({ length: SESSION_REFERENCE_SNAPSHOT_MAX_IDS + 3 }, (_, i) => `m${i}`)
      await expect(
        Promise.all(ids.map((id) => client.fingerprint("message", id)))
      ).resolves.toEqual(ids)
      expect(call.mock.calls.map((c) => (c[1] as { ids: string[] }).ids.length)).toEqual([
        SESSION_REFERENCE_SNAPSHOT_MAX_IDS,
        3,
      ])
    })

    it("fails every waiting check when the host cannot be asked", async () => {
      const { client } = transportAnswering(() => {
        throw new Error("offline")
      })
      const checks = [client.fingerprint("message", "a"), client.fingerprint("message", "b")]
      await expect(checks[0]).rejects.toThrow("offline")
      await expect(checks[1]).rejects.toThrow("offline")
    })

    it("fails only the checks the host skipped", async () => {
      const { client } = transportAnswering(() => ({ records: [{ id: "a", fingerprint: "fa" }] }))
      const a = client.fingerprint("message", "a")
      const b = client.fingerprint("message", "b")
      await expect(a).resolves.toBe("fa")
      await expect(b).rejects.toThrow(/did not answer for b/)
    })

    it("starts a new batch after the previous one went out", async () => {
      const { call, client } = transportAnswering((_name, args) => ({
        records: (args.ids as string[]).map((id) => ({ id, fingerprint: id })),
      }))
      await client.fingerprint("message", "a")
      await client.fingerprint("message", "b")
      expect(call).toHaveBeenCalledTimes(2)
    })
  })

  it("rebuilds a wire row without inventing fields it did not carry", () => {
    expect(candidateFromWire("result", { id: "m1:0", title: "grep" })).toEqual({
      entityKind: "result",
      id: "m1:0",
      title: "grep",
      searchText: "grep",
    })
  })
})

describe("routing", () => {
  describe("on the host itself", () => {
    it("reads this database and never touches the host client", async () => {
      const host = fakeHost()
      __setHostHistoryReferenceClientForTests(host)
      const local = fakeLocal()
      await expect(searchHistoryReferences("message", "q", {}, local)).resolves.toEqual({
        candidates: [row("local")],
      })
      await expect(snapshotHistoryReference("message", "s#m", local)).resolves.toBe("local body")
      await expect(fingerprintHistoryReference("message", "s#m", local)).resolves.toBe("local-fp")
      expect(host.search).not.toHaveBeenCalled()
      expect(host.read).not.toHaveBeenCalled()
      expect(host.fingerprint).not.toHaveBeenCalled()
    })
  })

  describe("on a paired device", () => {
    beforeEach(() => {
      profile = "mobile-companion"
    })

    it("searches the host's history, not the fragment synced here", async () => {
      const host = fakeHost()
      __setHostHistoryReferenceClientForTests(host)
      const local = fakeLocal()
      const ctx = { projectId: "p", sessionId: "s" }
      await expect(searchHistoryReferences("prompt", "deploy", ctx, local)).resolves.toEqual({
        candidates: [row("host")],
      })
      expect(host.search).toHaveBeenCalledWith("prompt", "deploy", ctx)
      expect(local.search).not.toHaveBeenCalled()
    })

    it("falls back to this device's copy when the host cannot answer, and says so", async () => {
      __setHostHistoryReferenceClientForTests(
        fakeHost({ search: jest.fn(async () => Promise.reject(new Error("offline"))) })
      )
      const local = fakeLocal()
      await expect(searchHistoryReferences("message", "q", {}, local)).resolves.toEqual({
        candidates: [row("local")],
        reach: "device-copy",
      })
    })

    it("lets a failing copy fail the search after the host already did", async () => {
      __setHostHistoryReferenceClientForTests(
        fakeHost({ search: jest.fn(async () => Promise.reject(new Error("offline"))) })
      )
      const local = fakeLocal({
        search: jest.fn(async () => Promise.reject(new Error("db closed"))),
      })
      await expect(searchHistoryReferences("message", "q", {}, local)).rejects.toThrow("db closed")
    })

    it("reads the body from the host", async () => {
      const host = fakeHost()
      __setHostHistoryReferenceClientForTests(host)
      const local = fakeLocal()
      await expect(snapshotHistoryReference("result", "m1:0", local)).resolves.toBe("host body")
      expect(host.read).toHaveBeenCalledWith("result", "m1:0")
      expect(local.snapshot).not.toHaveBeenCalled()
    })

    it("believes the host when it says the record is gone", async () => {
      __setHostHistoryReferenceClientForTests(
        fakeHost({
          read: jest.fn(async (_k: string, id: string) => ({ id, fingerprint: null, body: null })),
        })
      )
      const local = fakeLocal()
      await expect(snapshotHistoryReference("message", "s#m", local)).resolves.toBeNull()
      expect(local.snapshot).not.toHaveBeenCalled()
    })

    it("uses the copy's body only when the copy has the record", async () => {
      __setHostHistoryReferenceClientForTests(
        fakeHost({ read: jest.fn(async () => Promise.reject(new Error("offline"))) })
      )
      await expect(snapshotHistoryReference("message", "s#m", fakeLocal())).resolves.toBe(
        "local body"
      )
      // Not here either: "deleted" would be a lie. The host's error is the answer.
      const missing = fakeLocal({ snapshot: jest.fn(async () => null) })
      await expect(snapshotHistoryReference("message", "s#m", missing)).rejects.toThrow("offline")
    })

    it("checks freshness on the host and never against the copy", async () => {
      const host = fakeHost({
        fingerprint: jest.fn(async () => Promise.reject(new Error("offline"))),
      })
      __setHostHistoryReferenceClientForTests(host)
      const local = fakeLocal()
      await expect(fingerprintHistoryReference("message", "s#m", local)).rejects.toThrow("offline")
      expect(local.fingerprint).not.toHaveBeenCalled()
    })
  })
})
