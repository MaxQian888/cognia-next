// Coverage for the messages CRUD layer — list/persist/clear/truncateAfter.
// Persistence is diff-based so we exercise the upsert-vs-delete branches
// directly, plus the metadata hoisting (senderId/senderKind) round-trip.

import type { UIMessage } from "ai"
import {
  clearMessages,
  commitMessageDelta,
  deleteStoredMessage,
  listMessages,
  listRecentMessages,
  persistMessages,
  persistStreamingMessages,
  replaceSessionTranscript,
  truncateAfter,
  updateMessageMetadata,
} from "./messages"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { isMediaRef, putMessageMedia } from "./message-media"
import { listMessageMediaRefsForSession } from "./message-media-refs"

jest.setTimeout(30_000)

async function putSession(id: string, projectId = "proj-A"): Promise<void> {
  await getDb().sessions.put({
    id,
    projectId,
    title: id,
    updatedAt: 1,
    createdAt: 1,
  } as never)
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().messages.clear()
})
afterAll(dbFixture.dispose)

function msg(
  id: string,
  role: UIMessage["role"],
  text: string,
  metadata?: Record<string, unknown>
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    ...(metadata ? { metadata } : {}),
  } as UIMessage
}

describe("persistMessages + listMessages", () => {
  it("keeps omitted history when committing a partial delta", async () => {
    await replaceSessionTranscript("s-delta", [
      msg("old", "user", "old"),
      msg("current", "assistant", "before"),
    ])

    await commitMessageDelta("s-delta", {
      upserts: [msg("current", "assistant", "after"), msg("new", "user", "new")],
    })

    const stored = await listMessages("s-delta")
    expect(stored.map((message) => message.id)).toEqual(["old", "current", "new"])
    expect((stored[1]?.parts[0] as { text?: string }).text).toBe("after")
  })

  it("deletes only explicit ids owned by the target session", async () => {
    await replaceSessionTranscript("s-delta", [msg("a", "user", "a"), msg("b", "assistant", "b")])
    await replaceSessionTranscript("other", [msg("foreign", "user", "foreign")])

    await commitMessageDelta("s-delta", { deleteIds: ["a", "foreign", "missing"] })

    expect((await listMessages("s-delta")).map((message) => message.id)).toEqual(["b"])
    expect((await listMessages("other")).map((message) => message.id)).toEqual(["foreign"])
  })

  it("rejects attempts to move an existing message across sessions", async () => {
    await replaceSessionTranscript("owner", [msg("shared", "user", "owner")])

    await expect(
      commitMessageDelta("other", { upserts: [msg("shared", "assistant", "other")] })
    ).rejects.toThrow("cannot move")
  })

  it("increments the session revision only when the persisted transcript changes", async () => {
    await putSession("s-revision")
    const first = msg("u1", "user", "hello")

    await persistMessages("s-revision", [first])
    expect((await getDb().sessions.get("s-revision"))?.transcriptRevision).toBe(1)

    await persistMessages("s-revision", [first])
    expect((await getDb().sessions.get("s-revision"))?.transcriptRevision).toBe(1)

    await persistMessages("s-revision", [msg("u1", "user", "edited")])
    expect((await getDb().sessions.get("s-revision"))?.transcriptRevision).toBe(2)
  })

  it("ingests image data URLs before persistence and records their references", async () => {
    await persistMessages("s-media", [
      {
        id: "image-message",
        role: "user",
        parts: [
          {
            type: "file",
            url: "data:image/png;base64,aGVsbG8=",
            mediaType: "image/png",
          },
        ],
      } as UIMessage,
    ])

    const stored = await getDb().messages.get("image-message")
    const url = (stored?.parts[0] as { url?: string } | undefined)?.url
    expect(isMediaRef(url)).toBe(true)
    expect(await listMessageMediaRefsForSession("s-media")).toEqual([
      {
        messageId: "image-message",
        sessionId: "s-media",
        hash: url!.slice("cognia-media:".length),
      },
    ])
  })

  it("updates the reference ledger when a persisted message changes media", async () => {
    const first = msg("media", "user", "first")
    first.parts = [
      { type: "file", url: "data:image/png;base64,YQ==", mediaType: "image/png" },
    ] as UIMessage["parts"]
    await persistMessages("s-media", [first])

    const second = msg("media", "user", "second")
    second.parts = [
      { type: "file", url: "data:image/png;base64,Yg==", mediaType: "image/png" },
    ] as UIMessage["parts"]
    await persistMessages("s-media", [second])

    const refs = await listMessageMediaRefsForSession("s-media")
    expect(refs).toHaveLength(1)
    expect(refs[0]?.hash).toBe(
      getDb().messages &&
        ((await getDb().messages.get("media"))?.parts[0] as { url: string }).url.slice(
          "cognia-media:".length
        )
    )
  })

  it("inserts a fresh batch and reads them back in order", async () => {
    await persistMessages("s1", [msg("a", "user", "hello"), msg("b", "assistant", "hi")])
    const list = await listMessages("s1")
    expect(list.map((m) => m.id)).toEqual(["a", "b"])
    expect(list[0].role).toBe("user")
  })

  it("hoists senderId/senderKind from metadata into top-level columns", async () => {
    await persistMessages("s1", [
      msg("x", "assistant", "hey", {
        senderId: "char_42",
        senderKind: "assistant",
        usage: { tokens: 5 },
      }),
    ])
    const stored = await getDb().messages.get("x")
    expect(stored?.senderId).toBe("char_42")
    expect(stored?.senderKind).toBe("assistant")
    // The hoisted keys are stripped from the persisted metadata.
    expect(stored?.metadata).toEqual({ usage: { tokens: 5 } })
    // listMessages reconstructs them onto metadata for the UI layer.
    const list = await listMessages("s1")
    const out = list[0] as UIMessage & { metadata?: Record<string, unknown> }
    expect(out.metadata?.senderId).toBe("char_42")
    expect(out.metadata?.senderKind).toBe("assistant")
  })

  it("drops metadata when only routing keys were present", async () => {
    await persistMessages("s1", [
      msg("only-route", "assistant", "hi", { senderId: "c1", senderKind: "assistant" }),
    ])
    const stored = await getDb().messages.get("only-route")
    expect(stored?.metadata).toBeUndefined()
  })

  it("hydrates the createdAt column onto metadata for the UI layer", async () => {
    // The timeline minimap and the message action bar both read
    // `metadata.createdAt`; without this hoist they silently render no time
    // (timeline) or a bogus "now" (renderer fallback).
    await persistMessages("s1", [msg("t1", "user", "when?")])
    const stored = await getDb().messages.get("t1")
    const list = await listMessages("s1")
    const out = list[0] as UIMessage & { metadata?: Record<string, unknown> }
    expect(out.metadata?.createdAt).toBe(stored?.createdAt)
    expect(typeof out.metadata?.createdAt).toBe("number")
  })

  it("does not persist a hydrated createdAt back into the metadata blob", async () => {
    // Round-trip: listMessages hoists createdAt in, persistMessages must strip
    // it back out so the column stays the single source of truth.
    await persistMessages("s1", [msg("t2", "user", "hi", { usage: { tokens: 3 } })])
    const [loaded] = await listMessages("s1")
    await persistMessages("s1", [loaded])
    const stored = await getDb().messages.get("t2")
    expect(stored?.metadata).toEqual({ usage: { tokens: 3 } })
  })

  it("ignores invalid senderKind values", async () => {
    await persistMessages("s1", [msg("bad-kind", "assistant", "hey", { senderKind: "robot" })])
    const stored = await getDb().messages.get("bad-kind")
    expect(stored?.senderKind).toBeUndefined()
  })

  it("preserves createdAt on subsequent persists (no reordering churn)", async () => {
    await persistMessages("s1", [msg("a", "user", "1"), msg("b", "assistant", "2")])
    const first = await getDb().messages.get("a")
    await new Promise((r) => setTimeout(r, 5))
    await persistMessages("s1", [
      msg("a", "user", "1-edited"),
      msg("b", "assistant", "2"),
      msg("c", "user", "3"),
    ])
    const reloadedA = await getDb().messages.get("a")
    expect(reloadedA?.createdAt).toBe(first?.createdAt)
    // 'c' was new — gets a fresh timestamp at or after the persist call.
    const reloadedC = await getDb().messages.get("c")
    expect(reloadedC?.createdAt).toBeGreaterThanOrEqual(first!.createdAt)
  })

  it("deletes messages dropped from the incoming list", async () => {
    await persistMessages("s1", [msg("a", "user", "1"), msg("b", "assistant", "2")])
    await persistMessages("s1", [msg("a", "user", "1")])
    expect(await getDb().messages.get("b")).toBeUndefined()
  })

  it("empty incoming list with existing rows wipes the session", async () => {
    await persistMessages("s1", [msg("a", "user", "1")])
    await persistMessages("s1", [])
    expect((await listMessages("s1")).length).toBe(0)
  })

  it("empty incoming list with no existing rows is a no-op", async () => {
    await persistMessages("s1", [])
    expect((await listMessages("s1")).length).toBe(0)
  })

  it("auto-assigns ids when the caller omits them", async () => {
    const m: UIMessage = { role: "user", parts: [{ type: "text", text: "anon" }] } as UIMessage
    await persistMessages("s1", [m])
    const all = await getDb().messages.toArray()
    expect(all).toHaveLength(1)
    expect(all[0].id).toMatch(/^m_/)
  })

  it("updates only the trailing streaming row without scanning the session index", async () => {
    const first = msg("a", "assistant", "preface")
    const partial = msg("b", "assistant", "partial")
    await persistMessages("s-stream", [first, partial])
    const original = await getDb().messages.get("b")
    const whereSpy = jest.spyOn(getDb().messages, "where")

    await persistStreamingMessages("s-stream", [
      first,
      msg("b", "assistant", "partial response completed"),
    ])

    expect(whereSpy).not.toHaveBeenCalledWith("sessionId")
    whereSpy.mockRestore()
    const stored = await getDb().messages.get("b")
    expect(stored?.parts).toEqual([{ type: "text", text: "partial response completed" }])
    expect(stored?.createdAt).toBe(original?.createdAt)
    expect(await getDb().messages.get("a")).toBeDefined()
  }, 60_000)
})

describe("clearMessages", () => {
  it("drops every row in a session", async () => {
    await persistMessages("s1", [msg("a", "user", "1"), msg("b", "assistant", "2")])
    await persistMessages("s2", [msg("c", "user", "x")])
    await clearMessages("s1")
    expect(await listMessages("s1")).toHaveLength(0)
    expect(await listMessages("s2")).toHaveLength(1)
  })

  it("drops the session's media references and collects old orphans", async () => {
    await putMessageMedia({
      hash: "clear-me",
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: new Blob(["x"], { type: "image/png" }),
      byteSize: 1,
      createdAt: 0,
      lastUsedAt: 0,
    })
    await getDb().messages.put({
      id: "media-row",
      sessionId: "s-clear-media",
      role: "user",
      parts: [{ type: "file", url: "cognia-media:clear-me", mediaType: "image/png" }],
      createdAt: 1,
    } as never)
    await getDb().messageMediaRefs.put({
      messageId: "media-row",
      sessionId: "s-clear-media",
      hash: "clear-me",
    })

    await clearMessages("s-clear-media")

    expect(await listMessageMediaRefsForSession("s-clear-media")).toEqual([])
    expect(await getDb().messageMedia.get("clear-me")).toBeUndefined()
  })
})

describe("deleteStoredMessage", () => {
  it("deletes only the requested row", async () => {
    await persistMessages("s1", [msg("a", "user", "1"), msg("b", "assistant", "2")])

    await deleteStoredMessage("a")

    expect((await listMessages("s1")).map((message) => message.id)).toEqual(["b"])
  })

  it("ignores an unknown message id", async () => {
    await expect(deleteStoredMessage("missing")).resolves.toBeUndefined()
  })
})

describe("updateMessageMetadata", () => {
  it("merges a patch into one row's metadata without touching siblings", async () => {
    await persistMessages("s1", [msg("a", "user", "hi", { foo: 1 }), msg("b", "assistant", "yo")])
    await updateMessageMetadata("s1", "a", { minimapLabel: "Greeting" })
    const stored = await getDb().messages.get("a")
    expect(stored?.metadata).toEqual({ foo: 1, minimapLabel: "Greeting" })
    // Sibling untouched.
    expect(await getDb().messages.get("b")).toBeDefined()
  })

  it("does NOT delete a newer message that arrived after a stale snapshot", async () => {
    // The persist-race scenario: a background task captured [a] then writes a
    // label for it while turn [b] already landed. A whole-array persist would
    // bulkDelete b; the targeted update must not.
    await persistMessages("s1", [msg("a", "user", "first")])
    await persistMessages("s1", [msg("a", "user", "first"), msg("b", "user", "second")])
    await updateMessageMetadata("s1", "a", { minimapLabel: "L" })
    const ids = (await listMessages("s1")).map((m) => m.id)
    expect(ids).toEqual(["a", "b"])
  })

  it("ignores a message id from another session", async () => {
    await persistMessages("s1", [msg("a", "user", "1")])
    await persistMessages("s2", [msg("b", "user", "2")])
    await updateMessageMetadata("s1", "b", { minimapLabel: "x" })
    expect((await getDb().messages.get("b"))?.metadata).toBeUndefined()
  })

  it("strips derived routing keys from the patch", async () => {
    await persistMessages("s1", [msg("a", "user", "1")])
    await updateMessageMetadata("s1", "a", {
      minimapLabel: "L",
      senderId: "leak",
      sessionId: "leak",
    })
    expect(
      await getDb()
        .messages.get("a")
        .then((r) => r?.metadata)
    ).toEqual({ minimapLabel: "L" })
  })

  it("is a no-op for an unknown message id", async () => {
    await updateMessageMetadata("s1", "ghost", { minimapLabel: "x" })
    expect(await getDb().messages.get("ghost")).toBeUndefined()
  })
})

describe("truncateAfter", () => {
  it("drops everything strictly after the anchor by default", async () => {
    await persistMessages("s1", [
      msg("a", "user", "1"),
      msg("b", "assistant", "2"),
      msg("c", "user", "3"),
      msg("d", "assistant", "4"),
    ])
    await truncateAfter("s1", "b")
    const ids = (await listMessages("s1")).map((m) => m.id)
    expect(ids).toEqual(["a", "b"])
  })

  it("inclusive=true also removes the anchor", async () => {
    await persistMessages("s1", [
      msg("a", "user", "1"),
      msg("b", "assistant", "2"),
      msg("c", "user", "3"),
    ])
    await truncateAfter("s1", "b", { inclusive: true })
    const ids = (await listMessages("s1")).map((m) => m.id)
    expect(ids).toEqual(["a"])
  })

  it("does nothing when the anchor doesn't exist", async () => {
    await persistMessages("s1", [msg("a", "user", "1")])
    await truncateAfter("s1", "missing")
    expect((await listMessages("s1")).length).toBe(1)
  })

  it("does nothing when the anchor belongs to another session", async () => {
    await persistMessages("s1", [msg("a", "user", "1")])
    await persistMessages("s2", [msg("b", "user", "x")])
    await truncateAfter("s1", "b")
    expect((await listMessages("s1")).length).toBe(1)
  })

  it("is a no-op when nothing follows the anchor", async () => {
    await persistMessages("s1", [msg("a", "user", "1"), msg("b", "user", "2")])
    await truncateAfter("s1", "b")
    expect((await listMessages("s1")).length).toBe(2)
  })
})

describe("workspace (project) scoping", () => {
  it("stamps each message with the owning session's projectId", async () => {
    await getDb().sessions.put({
      id: "s-scoped",
      projectId: "proj-A",
      title: "a",
      updatedAt: 1,
      createdAt: 1,
    } as never)
    await persistMessages("s-scoped", [msg("m1", "user", "hi")])
    expect((await getDb().messages.get("m1"))?.projectId).toBe("proj-A")
  })
})

describe("last-message preview denormalization", () => {
  it("writes a capped preview + timestamp onto the session row", async () => {
    await putSession("s-prev")
    await persistMessages("s-prev", [msg("a", "user", "hello world")])
    const row = await getDb().sessions.get("s-prev")
    expect(row?.lastMessagePreview).toBe("hello world")
    expect(typeof row?.lastMessageAt).toBe("number")
  })

  it("updates the preview on a new message boundary but not on in-place growth", async () => {
    await putSession("s-prev")
    await persistMessages("s-prev", [msg("a", "user", "hello")])
    await persistMessages("s-prev", [msg("a", "user", "hello"), msg("b", "assistant", "wor")])
    const afterBoundary = await getDb().sessions.get("s-prev")
    expect(afterBoundary?.lastMessagePreview).toBe("wor")
    const atBoundary = afterBoundary?.lastMessageAt

    // Same last message id "b", grown text → boundary unchanged → preview frozen.
    await persistMessages("s-prev", [
      msg("a", "user", "hello"),
      msg("b", "assistant", "wor... a much longer streamed reply"),
    ])
    const afterGrowth = await getDb().sessions.get("s-prev")
    expect(afterGrowth?.lastMessagePreview).toBe("wor")
    expect(afterGrowth?.lastMessageAt).toBe(atBoundary)
  })

  it("skips denormalization when no session row exists", async () => {
    await persistMessages("s-orphan", [msg("a", "user", "hi")])
    expect(await getDb().sessions.get("s-orphan")).toBeUndefined()
  })
})

describe("thread handoff write guard", () => {
  it("does not persist transcript changes while the session is frozen", async () => {
    await getDb().sessions.put({
      id: "handoff-locked",
      projectId: "proj-A",
      title: "Frozen",
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
      updatedAt: 1,
      createdAt: 1,
    } as never)

    await expect(
      persistMessages("handoff-locked", [msg("blocked", "user", "must not persist")])
    ).rejects.toMatchObject({ code: "session_handoff_locked" })
    expect(await getDb().messages.where("sessionId").equals("handoff-locked").count()).toBe(0)
  })
})

describe("listRecentMessages", () => {
  // `@chat:` used to call `listMessages` and throw away all but the last 40 —
  // a read of every row of the session WITH its `parts`, where one tool result
  // can be tens of KB.
  // Message ids are the primary key, so they have to be unique ACROSS
  // sessions — reusing `m0` in two sessions moves the row rather than adding
  // one, which is how the leak test below silently emptied its own fixture.
  const id = (sessionId: string, i: number) => `${sessionId}-m${i}`

  async function seed(sessionId: string, count: number): Promise<void> {
    await putSession(sessionId)
    await replaceSessionTranscript(
      sessionId,
      Array.from({ length: count }, (_, i) =>
        msg(id(sessionId, i), i % 2 === 0 ? "user" : "assistant", `t${i}`)
      )
    )
  }

  it("returns the newest messages, still in ascending order", async () => {
    await seed("s-tail", 10)
    const tail = await listRecentMessages("s-tail", 3)
    expect(tail.map((m) => m.id)).toEqual([id("s-tail", 7), id("s-tail", 8), id("s-tail", 9)])
  })

  it("returns everything when the session is shorter than the limit", async () => {
    await seed("s-short", 2)
    expect((await listRecentMessages("s-short", 40)).map((m) => m.id)).toEqual([
      id("s-short", 0),
      id("s-short", 1),
    ])
  })

  it("returns nothing for a non-positive limit rather than reading the table", async () => {
    await seed("s-zero", 3)
    expect(await listRecentMessages("s-zero", 0)).toEqual([])
  })

  it("is empty for a session with no messages", async () => {
    await putSession("s-empty")
    expect(await listRecentMessages("s-empty", 5)).toEqual([])
  })

  it("hoists the same metadata listMessages does", async () => {
    await seed("s-meta", 3)
    const [first] = await listRecentMessages("s-meta", 1)
    const full = await listMessages("s-meta")
    expect(first).toEqual(full[full.length - 1])
    expect((first.metadata as { sessionId?: string }).sessionId).toBe("s-meta")
  })

  it("does not leak another session's messages", async () => {
    await seed("s-a", 3)
    await seed("s-b", 3)
    const tail = await listRecentMessages("s-a", 10)
    expect(tail).toHaveLength(3)
    expect(tail.every((m) => (m.metadata as { sessionId?: string }).sessionId === "s-a")).toBe(true)
  })
})
