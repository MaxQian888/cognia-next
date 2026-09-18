/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { isTranscriptEntityRefId, scanSharedTranscriptReferences } from "./shared-reference-scan"

const dbFixture = createDbTestFixture()

function message(id: string, sessionId: string, metadata?: Record<string, unknown>) {
  return {
    id,
    sessionId,
    role: "user" as const,
    parts: [{ type: "text" as const, text: "body" }],
    createdAt: 1,
    ...(metadata ? { metadata } : {}),
  }
}

const sessionMention = (sessionId: string, label = "Session chip") => ({
  kind: "entity",
  id: `session:${sessionId}`,
  label,
})

describe("isTranscriptEntityRefId", () => {
  it.each([
    ["session:s1", true],
    ["message:s1#m1", true],
    ["prompt:s1#m1", true],
    ["result:m1:2", true],
    ["memory:mem_1", false],
    ["issue:COG-1", false],
    ["artifact:a1", false],
    ["file:src/x.ts", false],
    ["no-prefix", false],
    [":orphan", false],
  ])("%s → %s", (id, expected) => {
    expect(isTranscriptEntityRefId(id)).toBe(expected)
  })
})

describe("scanSharedTranscriptReferences", () => {
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().sessions.bulkPut([
      {
        id: "local_1",
        projectId: "w1",
        title: "The conversation being shared",
        kind: "direct",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "source_a",
        projectId: "w1",
        title: "Sprint planning",
        kind: "direct",
        createdAt: 1,
        updatedAt: 1,
      },
    ])
  })
  afterAll(dbFixture.dispose)

  it("returns nothing for a transcript with no references", async () => {
    await getDb().messages.put(message("m1", "local_1"))
    await expect(scanSharedTranscriptReferences("local_1")).resolves.toEqual([])
  })

  it("names the source conversation for a @chat: mention", async () => {
    await getDb().messages.put(message("m1", "local_1", { mentions: [sessionMention("source_a")] }))
    const refs = await scanSharedTranscriptReferences("local_1")
    expect(refs).toEqual([
      { entityKind: "session", sessionId: "source_a", title: "Sprint planning" },
    ])
  })

  it("resolves a @msg: id's owning session through the # split", async () => {
    await getDb().messages.put(
      message("m1", "local_1", {
        mentions: [{ kind: "entity", id: "message:source_a#msg_9", label: "turn nine" }],
      })
    )
    const refs = await scanSharedTranscriptReferences("local_1")
    expect(refs).toEqual([
      { entityKind: "message", sessionId: "source_a", title: "Sprint planning" },
    ])
  })

  it("resolves a @result: id through its owning message row", async () => {
    // The result id names a message part; the source session comes from the row.
    await getDb().messages.put(message("origin_msg", "source_a"))
    await getDb().messages.put(
      message("m1", "local_1", {
        mentions: [{ kind: "entity", id: "result:origin_msg:0", label: "tool output" }],
      })
    )
    const refs = await scanSharedTranscriptReferences("local_1")
    expect(refs).toEqual([
      { entityKind: "result", sessionId: "source_a", title: "Sprint planning" },
    ])
  })

  it("keeps the chip label when the source session row is gone", async () => {
    // A `session:` id IS the source session id — recoverable from the ref even
    // when the row itself was deleted, so the title stays the chip's label.
    await getDb().messages.put(
      message("m1", "local_1", { mentions: [sessionMention("gone_session", "Deleted chat")] })
    )
    const refs = await scanSharedTranscriptReferences("local_1")
    expect(refs).toEqual([
      { entityKind: "session", sessionId: "gone_session", title: "Deleted chat" },
    ])
  })

  it("excludes references into the session being shared", async () => {
    await getDb().messages.put(
      message("m1", "local_1", {
        mentions: [
          sessionMention("local_1"),
          { kind: "entity", id: "message:local_1#m0", label: "self" },
        ],
      })
    )
    await expect(scanSharedTranscriptReferences("local_1")).resolves.toEqual([])
  })

  it("ignores non-transcript entity kinds and malformed mentions", async () => {
    await getDb().messages.put(
      message("m1", "local_1", {
        mentions: [
          { kind: "entity", id: "memory:mem_1", label: "a memory" },
          { kind: "entity", id: "issue:COG-1", label: "an issue" },
          { kind: "file", id: "file:src/x.ts", label: "x.ts" },
          { not: "a ref" },
          "garbage",
        ],
      })
    )
    await expect(scanSharedTranscriptReferences("local_1")).resolves.toEqual([])
  })

  it("deduplicates two mentions of the same source conversation", async () => {
    await getDb().messages.bulkPut([
      message("m1", "local_1", { mentions: [sessionMention("source_a")] }),
      message("m2", "local_1", {
        mentions: [{ kind: "entity", id: "message:source_a#msg_9", label: "turn nine" }],
      }),
    ])
    const refs = await scanSharedTranscriptReferences("local_1")
    // Same source conversation, but a session-ref and a message-ref are
    // distinct kinds of snapshot — both are listed, once each.
    expect(refs).toHaveLength(2)
    expect(refs.map((ref) => ref.entityKind).sort()).toEqual(["message", "session"])
  })

  it("covers rows that carry only a promptPreamble summary", async () => {
    await getDb().messages.put(
      message("m1", "local_1", {
        promptPreamble: {
          sections: ["references"],
          references: [{ kind: "entity", entityKind: "session", title: "Retro notes" }],
        },
      })
    )
    const refs = await scanSharedTranscriptReferences("local_1")
    expect(refs).toEqual([{ entityKind: "session", title: "Retro notes" }])
  })

  it("does not double-count a preamble reference a mention already named", async () => {
    await getDb().messages.put(
      message("m1", "local_1", {
        mentions: [sessionMention("source_a")],
        promptPreamble: {
          sections: ["references"],
          references: [
            { kind: "entity", entityKind: "session", title: "Sprint planning" },
            { kind: "entity", entityKind: "session", title: "Another chat" },
          ],
        },
      })
    )
    const refs = await scanSharedTranscriptReferences("local_1")
    // "Sprint planning" is the mention's resolved title — the preamble entry
    // for it collapses into the named row; "Another chat" stands alone.
    expect(refs).toEqual([
      { entityKind: "session", sessionId: "source_a", title: "Sprint planning" },
      { entityKind: "session", title: "Another chat" },
    ])
  })

  it("keeps two preamble references of the same kind with different titles", async () => {
    await getDb().messages.put(
      message("m1", "local_1", {
        promptPreamble: {
          sections: ["references"],
          references: [
            { kind: "entity", entityKind: "message", title: "first turn" },
            { kind: "entity", entityKind: "message", title: "second turn" },
          ],
        },
      })
    )
    const refs = await scanSharedTranscriptReferences("local_1")
    expect(refs).toEqual([
      { entityKind: "message", title: "first turn" },
      { entityKind: "message", title: "second turn" },
    ])
  })
})
