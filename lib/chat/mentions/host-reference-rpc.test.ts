import type { EntityMentionCandidate } from "./entity-sources"
import {
  SESSION_REFERENCE_BODY_MAX_CHARS,
  sessionReferenceSearch,
  sessionReferenceSnapshot,
  clampReferenceBody,
  parseSessionReferenceSearchRequest,
  parseSessionReferenceSnapshotRequest,
  wireCandidate,
} from "./host-reference-rpc"
import {
  SESSION_REFERENCE_QUERY_MAX_CHARS,
  SESSION_REFERENCE_SEARCH_COMMAND,
  SESSION_REFERENCE_SNAPSHOT_COMMAND,
  SESSION_REFERENCE_SNAPSHOT_MAX_IDS,
  createHostHistoryReferenceClient,
} from "./host-references"

// The host answers with the reads its own composer runs. Those reads have
// their own suites (`entity-sources.test.ts`, `prompt-reference.test.ts`); here
// they are stand-ins, so this suite pins what the host hands over and in what
// shape, not what the database holds.
const local = {
  search: jest.fn(),
  snapshot: jest.fn(),
  fingerprint: jest.fn(),
}
const localHistoryReference = jest.fn((_kind: string) => local)
jest.mock("./entity-sources", () => ({
  ...jest.requireActual("./entity-sources"),
  localHistoryReference: (kind: string) => localHistoryReference(kind),
}))

function candidate(over: Partial<EntityMentionCandidate> = {}): EntityMentionCandidate {
  return {
    entityKind: "message",
    id: "s1#m1",
    title: "Release prep",
    subtitle: "user · 2026-09-01 · tag it",
    href: "/?session=s1&message=m1",
    sourceSessionId: "s1",
    searchText: "release prep user tag it",
    ...over,
  }
}

beforeEach(() => {
  local.search.mockReset().mockResolvedValue([])
  local.snapshot.mockReset().mockResolvedValue(null)
  local.fingerprint.mockReset().mockResolvedValue(null)
  localHistoryReference.mockClear()
})

describe("request parsing", () => {
  it("accepts a search and drops empty scope fields", () => {
    expect(
      parseSessionReferenceSearchRequest({
        kind: "prompt",
        query: "ship",
        projectId: "",
        sessionId: "s",
      })
    ).toEqual({ kind: "prompt", query: "ship", sessionId: "s" })
  })

  it.each([
    ["a non-object", "nope"],
    ["an unknown kind", { kind: "memory", query: "" }],
    ["a missing query", { kind: "message" }],
    [
      "an oversized query",
      { kind: "message", query: "x".repeat(SESSION_REFERENCE_QUERY_MAX_CHARS + 1) },
    ],
    ["a non-string scope", { kind: "message", query: "", projectId: 7 }],
  ])("refuses %s as a search", (_label, payload) => {
    expect(() => parseSessionReferenceSearchRequest(payload)).toThrow(
      SESSION_REFERENCE_SEARCH_COMMAND
    )
  })

  it("accepts a snapshot and asks once per record", () => {
    expect(
      parseSessionReferenceSnapshotRequest({
        kind: "result",
        ids: ["a", "b", "a"],
        withBody: false,
      })
    ).toEqual({ kind: "result", ids: ["a", "b"], withBody: false })
  })

  it.each([
    ["no ids", { kind: "result", ids: [], withBody: false }],
    [
      "too many ids",
      {
        kind: "result",
        ids: Array.from({ length: SESSION_REFERENCE_SNAPSHOT_MAX_IDS + 1 }, (_, i) => `m${i}`),
        withBody: false,
      },
    ],
    ["an empty id", { kind: "result", ids: [""], withBody: false }],
    ["a non-string id", { kind: "result", ids: [1], withBody: false }],
    ["no body flag", { kind: "result", ids: ["a"] }],
    ["an unknown kind", { kind: "issue", ids: ["a"], withBody: true }],
  ])("refuses %s as a snapshot", (_label, payload) => {
    expect(() => parseSessionReferenceSnapshotRequest(payload)).toThrow(
      SESSION_REFERENCE_SNAPSHOT_COMMAND
    )
  })
})

describe("sessionReferenceSearch", () => {
  it("runs the host's own read for the kind, in the device's place", async () => {
    local.search.mockResolvedValue([candidate()])
    await expect(
      sessionReferenceSearch({ kind: "message", query: "  tag ", projectId: "p1", sessionId: "s9" })
    ).resolves.toEqual({
      candidates: [
        {
          id: "s1#m1",
          title: "Release prep",
          subtitle: "user · 2026-09-01 · tag it",
          href: "/?session=s1&message=m1",
          sourceSessionId: "s1",
        },
      ],
    })
    expect(localHistoryReference).toHaveBeenCalledWith("message")
    expect(local.search).toHaveBeenCalledWith("tag", { projectId: "p1", sessionId: "s9" })
  })

  it("answers an unscoped search with no scope", async () => {
    await sessionReferenceSearch({ kind: "result", query: "" })
    expect(local.search).toHaveBeenCalledWith("", { projectId: null, sessionId: null })
  })

  it("never answers with more rows than the picker shows", async () => {
    local.search.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => candidate({ id: `s1#m${i}` }))
    )
    const { ENTITY_MENTION_RESULT_LIMIT } = jest.requireActual("./entity-sources")
    const { candidates } = await sessionReferenceSearch({ kind: "message", query: "q" })
    expect(candidates).toHaveLength(ENTITY_MENTION_RESULT_LIMIT)
  })

  it("refuses a malformed request before reading anything", async () => {
    await expect(sessionReferenceSearch({ kind: "memory", query: "" })).rejects.toThrow()
    expect(local.search).not.toHaveBeenCalled()
  })
})

describe("wireCandidate", () => {
  it("keeps a prompt's words when they fit", () => {
    expect(wireCandidate(candidate({ entityKind: "prompt", insertText: "ship it" }))).toMatchObject(
      {
        insertText: "ship it",
      }
    )
  })

  it("drops words too long to carry rather than putting half of them back", () => {
    const wire = wireCandidate(
      candidate({
        entityKind: "prompt",
        insertText: "x".repeat(SESSION_REFERENCE_BODY_MAX_CHARS + 1),
      })
    )
    expect(wire).not.toHaveProperty("insertText")
    expect(wire.id).toBe("s1#m1")
  })
})

describe("sessionReferenceSnapshot", () => {
  it("answers a freshness check with fingerprints alone", async () => {
    local.fingerprint.mockImplementation(async (id: string) => (id === "gone" ? null : `fp:${id}`))
    await expect(
      sessionReferenceSnapshot({ kind: "message", ids: ["s#a", "gone"], withBody: false })
    ).resolves.toEqual({
      records: [
        { id: "s#a", fingerprint: "fp:s#a" },
        { id: "gone", fingerprint: null },
      ],
    })
    expect(local.snapshot).not.toHaveBeenCalled()
  })

  it("reads the body and its fingerprint together", async () => {
    local.fingerprint.mockResolvedValue("fp")
    local.snapshot.mockResolvedValue("Result of grep:\nhit")
    await expect(
      sessionReferenceSnapshot({ kind: "result", ids: ["m1:0"], withBody: true })
    ).resolves.toEqual({
      records: [{ id: "m1:0", fingerprint: "fp", body: "Result of grep:\nhit" }],
    })
  })

  it("says a record is gone with a null body", async () => {
    await expect(
      sessionReferenceSnapshot({ kind: "prompt", ids: ["s#m"], withBody: true })
    ).resolves.toEqual({ records: [{ id: "s#m", fingerprint: null, body: null }] })
  })

  it("bounds one enormous body and marks the cut", async () => {
    local.fingerprint.mockResolvedValue("fp")
    local.snapshot.mockResolvedValue("y".repeat(SESSION_REFERENCE_BODY_MAX_CHARS + 500))
    const {
      records: [record],
    } = await sessionReferenceSnapshot({ kind: "result", ids: ["m1:0"], withBody: true })
    expect(record!.body!.startsWith("y".repeat(SESSION_REFERENCE_BODY_MAX_CHARS))).toBe(true)
    expect(record!.body).toContain("[Truncated by Cognia")
  })
})

describe("clampReferenceBody", () => {
  it("leaves a body within the ceiling untouched", () => {
    const body = "z".repeat(SESSION_REFERENCE_BODY_MAX_CHARS)
    expect(clampReferenceBody(body)).toBe(body)
  })

  // The ceiling sits above what a chip keeps, so the device's own clamp still
  // decides where a long record is cut and the model reads that marker.
  it("stays above what a staged chip keeps", () => {
    const { MAX_ENTITY_SNAPSHOT_CHARS } = jest.requireActual("./entity-sources")
    expect(SESSION_REFERENCE_BODY_MAX_CHARS).toBeGreaterThan(MAX_ENTITY_SNAPSHOT_CHARS)
  })
})

describe("a device asking this host over the wire", () => {
  // The device's client against these handlers, with a JSON round trip in
  // between: whatever the host answers has to survive serialization and parse
  // back into the rows and records the device's panel and staging path use.
  function wiredClient() {
    return createHostHistoryReferenceClient(async () => ({
      call: async (name: string, args?: Record<string, unknown>) => {
        const payload = JSON.parse(JSON.stringify(args ?? {}))
        const answer =
          name === SESSION_REFERENCE_SEARCH_COMMAND
            ? await sessionReferenceSearch(payload)
            : await sessionReferenceSnapshot(payload)
        return JSON.parse(JSON.stringify(answer)) as never
      },
    }))
  }

  it("gets the rows the host's own picker would list", async () => {
    const hostRow = candidate({ entityKind: "prompt", id: "s1#m2", insertText: "ship it" })
    local.search.mockResolvedValue([hostRow])
    const [row] = await wiredClient().search("prompt", "ship", { projectId: "p1" })
    expect(row).toEqual({ ...hostRow, searchText: expect.any(String) })
  })

  it("stages a record and later checks it against the same fingerprint", async () => {
    local.fingerprint.mockResolvedValue("1:abc")
    local.snapshot.mockResolvedValue("body")
    const client = wiredClient()
    await expect(client.read("message", "s1#m1")).resolves.toEqual({
      id: "s1#m1",
      fingerprint: "1:abc",
      body: "body",
    })
    await expect(client.fingerprint("message", "s1#m1")).resolves.toBe("1:abc")
  })
})
