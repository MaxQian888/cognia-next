/** @jest-environment jsdom */
// Clobber-guard tests for external-agent session re-import (ADR-0062).

import "fake-indexeddb/auto"
import { applyImportedMerged, mergeImportedSession } from "./import-merge"
import type { ImportedConversation } from "./importers/types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

// Cold Dexie delete + reseed in beforeEach can exceed the default 5s hook
// timeout under parallel-worker CPU contention (repo idiom for Dexie suites).
jest.setTimeout(30_000)

function makeConv(
  id: string,
  session: Partial<ChatSession> = {},
  msgTexts: string[] = ["hi", "yo"]
): ImportedConversation {
  const messages: StoredMessage[] = msgTexts.map((t, i) => ({
    id: `${id}:m${i}`,
    sessionId: id,
    role: (i % 2 === 0 ? "user" : "assistant") as StoredMessage["role"],
    parts: [{ type: "text", text: t, state: "done" }] as unknown as StoredMessage["parts"],
    createdAt: 1000 + i,
  }))
  return {
    session: {
      id,
      title: "Imported title",
      titleAuto: true,
      kind: "direct",
      branchSeed: { kind: "transcript", content: "seed" },
      createdAt: 1000,
      updatedAt: 2000,
      ...session,
    } as ChatSession,
    messages,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
})

describe("mergeImportedSession (pure)", () => {
  const incoming = makeConv("import:codex:s1", { title: "Fresh", updatedAt: 9000 }).session

  it("returns incoming verbatim when there is no existing row", () => {
    expect(mergeImportedSession(incoming, undefined)).toBe(incoming)
  })

  it("preserves the SDK link + local decorations from the existing row", () => {
    const existing = {
      ...incoming,
      sdkSessionId: "sdk-123",
      forkedFromSdkSessionId: "fork-9",
      pinned: true,
      folderId: "folder-a",
      manualOrder: 3,
      manualOrderSection: "pinned",
      archivedAt: 555,
      parentSessionId: "import:codex:parent",
      branchedFromMessageId: "m4",
      branchKind: "summary" as const,
      projectId: "proj-x",
    } as ChatSession
    const merged = mergeImportedSession({ ...incoming, projectId: "proj-NEW" }, existing)
    // Content refreshed…
    expect(merged.title).toBe("Fresh")
    expect(merged.updatedAt).toBe(9000)
    // …decorations preserved.
    expect(merged.sdkSessionId).toBe("sdk-123")
    expect(merged.forkedFromSdkSessionId).toBe("fork-9")
    expect(merged.pinned).toBe(true)
    expect(merged.folderId).toBe("folder-a")
    expect(merged.manualOrder).toBe(3)
    expect(merged.manualOrderSection).toBe("pinned")
    expect(merged.archivedAt).toBe(555)
    expect(merged.parentSessionId).toBe("import:codex:parent")
    expect(merged.branchedFromMessageId).toBe("m4")
    expect(merged.branchKind).toBe("summary")
    expect(merged.projectId).toBe("proj-x")
  })

  it("lets a user rename (titleAuto:false) win over the re-derived title", () => {
    const existing = { ...incoming, title: "My Name", titleAuto: false } as ChatSession
    const merged = mergeImportedSession({ ...incoming, title: "Auto Again" }, existing)
    expect(merged.title).toBe("My Name")
    expect(merged.titleAuto).toBe(false)
  })

  it("refreshes the auto title when the user never renamed", () => {
    const existing = { ...incoming, title: "Old Auto", titleAuto: true } as ChatSession
    const merged = mergeImportedSession({ ...incoming, title: "New Auto" }, existing)
    expect(merged.title).toBe("New Auto")
  })
})

describe("applyImportedMerged", () => {
  it("returns zero counts for empty input", async () => {
    expect(await applyImportedMerged([])).toEqual({ sessions: 0, messages: 0 })
  })

  it("writes a fresh import", async () => {
    const counts = await applyImportedMerged([makeConv("import:codex:s1")])
    expect(counts).toEqual({ sessions: 1, messages: 2 })
    const db = getDb()
    expect(await db.sessions.count()).toBe(1)
    expect(await db.messages.count()).toBe(2)
  })

  it("re-import of a continued session preserves sdkSessionId + decorations + the user's added turn", async () => {
    const db = getDb()
    // First import.
    await applyImportedMerged([makeConv("import:codex:s1")])
    // Simulate a continuation: SDK link captured, user pinned + foldered it, and
    // a new turn was appended with a normal (non `:m`) id.
    await db.sessions.update("import:codex:s1", {
      sdkSessionId: "sdk-abc",
      pinned: true,
      folderId: "f1",
    })
    await db.messages.put({
      id: "continuation-uuid",
      sessionId: "import:codex:s1",
      role: "user",
      parts: [{ type: "text", text: "keep going" }] as unknown as StoredMessage["parts"],
      createdAt: 5000,
    })
    // Re-import (e.g. fs-watch saw the source grow) — fresh skeleton, no sdkSessionId.
    const counts = await applyImportedMerged([
      makeConv("import:codex:s1", { updatedAt: 8000 }, ["hi", "yo", "third"]),
    ])
    expect(counts.sessions).toBe(1)

    const row = await db.sessions.get("import:codex:s1")
    expect(row?.sdkSessionId).toBe("sdk-abc") // <-- resume link NOT clobbered
    expect(row?.pinned).toBe(true)
    expect(row?.folderId).toBe("f1")
    expect(row?.updatedAt).toBe(8000) // content refreshed
    // The user's appended turn survives; imported turns upsert by deterministic id.
    expect(await db.messages.get("continuation-uuid")).toBeTruthy()
    expect(await db.messages.get("import:codex:s1:m2")).toBeTruthy()
  })

  it("skips a frozen session entirely (source diverged, Cognia owns it)", async () => {
    const db = getDb()
    await applyImportedMerged([makeConv("import:codex:s1")])
    await db.sessions.update("import:codex:s1", {
      importFrozen: true,
      title: "User owns this",
      titleAuto: false,
    })
    // Source changed on disk; re-import must be a no-op on this row.
    const counts = await applyImportedMerged([
      makeConv("import:codex:s1", { title: "Source Changed", updatedAt: 9999 }, [
        "a",
        "b",
        "c",
        "d",
      ]),
    ])
    expect(counts.sessions).toBe(0)
    expect(counts.messages).toBe(0)

    const row = await db.sessions.get("import:codex:s1")
    expect(row?.title).toBe("User owns this")
    expect(row?.updatedAt).not.toBe(9999)
    // No extra imported messages written.
    expect(await db.messages.where("sessionId").equals("import:codex:s1").count()).toBe(2)
  })

  it("processes a batch, skipping only the frozen members", async () => {
    const db = getDb()
    await applyImportedMerged([makeConv("import:codex:a"), makeConv("import:codex:b")])
    await db.sessions.update("import:codex:a", { importFrozen: true })

    const counts = await applyImportedMerged([
      makeConv("import:codex:a", { title: "changed-a" }),
      makeConv("import:codex:b", { title: "changed-b" }),
    ])
    expect(counts.sessions).toBe(1)
    expect((await db.sessions.get("import:codex:a"))?.title).toBe("Imported title")
    expect((await db.sessions.get("import:codex:b"))?.title).toBe("changed-b")
  })
})
