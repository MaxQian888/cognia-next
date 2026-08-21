/** @jest-environment jsdom */
// Clobber-guard tests for external-agent session re-import (ADR-0062).

import "fake-indexeddb/auto"
import { applyImportedMerged, importSourceDigest, mergeImportedSession } from "./import-merge"
import type { ImportedConversation } from "./importers/types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { isMediaRef, parseMediaRef } from "@/lib/db/message-media"

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

  it("moves imported inline images into the media store and maintains authorization refs", async () => {
    const conversation = makeConv("import:codex:media", {}, [])
    conversation.messages = [
      {
        id: "import:codex:media:m0",
        sessionId: conversation.session.id,
        role: "user",
        parts: [
          {
            type: "file",
            url: "data:image/png;base64,aGVsbG8=",
            mediaType: "image/png",
          },
        ] as StoredMessage["parts"],
        createdAt: 1000,
      },
    ]

    await applyImportedMerged([conversation])

    const db = getDb()
    const stored = await db.messages.get("import:codex:media:m0")
    const ref = (stored?.parts[0] as { url?: string } | undefined)?.url
    expect(isMediaRef(ref)).toBe(true)
    expect(await db.messageMedia.count()).toBe(1)
    await expect(
      db.messageMediaRefs.get(["import:codex:media:m0", parseMediaRef(ref!)!])
    ).resolves.toMatchObject({
      sessionId: "import:codex:media",
    })
    await expect(db.sessions.get("import:codex:media")).resolves.toMatchObject({
      transcriptRevision: 1,
    })
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

  describe("search index projection (ADR-0099)", () => {
    it("projects imported messages so the history is findable by content", async () => {
      // The idle indexer only projects sessions the chat paths mark dirty, and
      // the lazy backfill is a one-way descending walk that latches `complete`.
      // So on an account whose walk had already finished, history imported
      // afterwards was invisible to global search forever.
      const db = getDb()
      await applyImportedMerged([makeConv("import:codex:s1", {}, ["find me", "sure"])])

      const rows = await db.chatSearchText.where("sessionId").equals("import:codex:s1").toArray()
      expect(rows.map((r) => r.text).sort()).toEqual(["find me", "sure"])
      expect(rows.every((r) => r.projectId === "")).toBe(true)
    })

    it("stamps the projection with the session's workspace", async () => {
      const db = getDb()
      const conv = makeConv("import:codex:s2", { projectId: "w1" }, ["scoped"])
      for (const message of conv.messages) message.projectId = "w1"
      await applyImportedMerged([conv])

      const rows = await db.chatSearchText.where("sessionId").equals("import:codex:s2").toArray()
      expect(rows).toHaveLength(1)
      expect(rows[0].projectId).toBe("w1")
    })

    it("writes no projection for a frozen session", async () => {
      const db = getDb()
      await applyImportedMerged([makeConv("import:codex:s3", {}, ["original"])])
      await db.sessions.update("import:codex:s3", { importFrozen: true })
      await db.chatSearchText.where("sessionId").equals("import:codex:s3").delete()

      await applyImportedMerged([makeConv("import:codex:s3", {}, ["source changed"])])
      expect(await db.chatSearchText.where("sessionId").equals("import:codex:s3").count()).toBe(0)
    })
  })
})

describe("frozen-source divergence (ADR-0062)", () => {
  it("records a digest of the source on every mirrored write", async () => {
    const conv = makeConv("import:codex:d1")
    await applyImportedMerged([conv])
    const row = await getDb().sessions.get("import:codex:d1")
    expect(row?.importSourceDigest).toBe(importSourceDigest(conv.messages))
  })

  it("flags a frozen row whose source moved, without touching its transcript", async () => {
    await applyImportedMerged([makeConv("import:codex:d2", {}, ["hi", "yo"])])
    await getDb().sessions.update("import:codex:d2", { importFrozen: true })
    const before = await getDb().sessions.get("import:codex:d2")

    // The agent kept running on disk: one more turn.
    await applyImportedMerged([makeConv("import:codex:d2", {}, ["hi", "yo", "and more"])])

    const after = await getDb().sessions.get("import:codex:d2")
    expect(after?.importDiverged).toBe(true)
    expect(after?.importDivergedAt).toEqual(expect.any(Number))
    // Frozen still means frozen: the content the user owns is untouched.
    expect(after?.title).toBe(before?.title)
    expect(after?.transcriptRevision).toBe(before?.transcriptRevision)
    expect(await getDb().messages.where("sessionId").equals("import:codex:d2").count()).toBe(2)
  })

  it("does not flag a frozen row when the source has not moved", async () => {
    await applyImportedMerged([makeConv("import:codex:d3")])
    await getDb().sessions.update("import:codex:d3", { importFrozen: true })
    await applyImportedMerged([makeConv("import:codex:d3")])
    expect((await getDb().sessions.get("import:codex:d3"))?.importDiverged).toBeUndefined()
  })

  it("does not re-stamp the timestamp for the same unchanged divergence", async () => {
    await applyImportedMerged([makeConv("import:codex:d4", {}, ["a"])])
    await getDb().sessions.update("import:codex:d4", { importFrozen: true })
    await applyImportedMerged([makeConv("import:codex:d4", {}, ["a", "b"])])
    const first = (await getDb().sessions.get("import:codex:d4"))?.importDivergedAt

    await applyImportedMerged([makeConv("import:codex:d4", {}, ["a", "b"])])
    expect((await getDb().sessions.get("import:codex:d4"))?.importDivergedAt).toBe(first)
  })

  it("keeps an unacknowledged divergence across a later mirrored write", async () => {
    // A row can be un-frozen (a fresh import of a session the user abandoned);
    // the flag is Cognia's bookkeeping, not the source's, so a re-parse must not
    // silently clear a warning the user has not seen.
    await applyImportedMerged([makeConv("import:codex:d5")])
    await getDb().sessions.update("import:codex:d5", { importDiverged: true })
    await applyImportedMerged([makeConv("import:codex:d5", {}, ["hi", "yo", "more"])])
    expect((await getDb().sessions.get("import:codex:d5"))?.importDiverged).toBe(true)
  })

  it("establishes a baseline for a legacy frozen row before detecting later divergence", async () => {
    // Pre-existing installs have `importFrozen` but no `importSourceDigest`.
    // The first observation is a baseline, not evidence of divergence.
    const conv = makeConv("import:codex:d6")
    await getDb().sessions.put({ ...conv.session, importFrozen: true } as never)
    const baseline = makeConv("import:codex:d6", {}, ["hi", "yo", "more"])
    await applyImportedMerged([baseline])
    const observed = await getDb().sessions.get("import:codex:d6")
    expect(observed?.importSourceDigest).toBe(importSourceDigest(baseline.messages))
    expect(observed?.importDiverged).toBeUndefined()

    await applyImportedMerged([makeConv("import:codex:d6", {}, ["hi", "yo", "more", "later"])])
    expect((await getDb().sessions.get("import:codex:d6"))?.importDiverged).toBe(true)
  })
})
