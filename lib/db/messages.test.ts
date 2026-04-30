// Coverage for the messages CRUD layer — list/persist/clear/truncateAfter.
// Persistence is diff-based so we exercise the upsert-vs-delete branches
// directly, plus the metadata hoisting (senderId/senderKind) round-trip.

import "fake-indexeddb/auto"
import type { UIMessage } from "ai"
import { clearMessages, listMessages, persistMessages, truncateAfter } from "./messages"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().messages.clear()
})

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
})

describe("clearMessages", () => {
  it("drops every row in a session", async () => {
    await persistMessages("s1", [msg("a", "user", "1"), msg("b", "assistant", "2")])
    await persistMessages("s2", [msg("c", "user", "x")])
    await clearMessages("s1")
    expect(await listMessages("s1")).toHaveLength(0)
    expect(await listMessages("s2")).toHaveLength(1)
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
