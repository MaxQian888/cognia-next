/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import {
  createEmptyHostStateSession,
  sessionStateChannel,
} from "@cognia/agent-config-types/host-state"
import {
  clearDraft,
  DRAFT_ATTACHMENT_QUOTA_BYTES,
  enforceDraftAttachmentQuota,
  flushDebouncedDraftWrites,
  getDraft,
  setDraft,
  setDraftDebounced,
} from "./chat-drafts"

beforeEach(async () => {
  clearActiveRuntimeTargetContext()
  __resetRuntimeSnapshotForTesting()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

afterEach(() => {
  clearActiveRuntimeTargetContext()
  __resetRuntimeSnapshotForTesting()
})

describe("chat-drafts", () => {
  it("getDraft returns null when no row exists", async () => {
    expect(await getDraft("ses_missing")).toBeNull()
  })

  it("setDraft writes a row and getDraft retrieves it", async () => {
    await setDraft("ses_a", "hello")
    const row = await getDraft("ses_a")
    expect(row).not.toBeNull()
    expect(row?.text).toBe("hello")
    expect(row?.sessionId).toBe("ses_a")
    expect(typeof row?.updatedAt).toBe("number")
    expect(row!.updatedAt).toBeGreaterThan(0)
  })

  it("setDraft overwrites an existing row (upsert by sessionId)", async () => {
    await setDraft("ses_a", "first")
    await setDraft("ses_a", "second")
    const row = await getDraft("ses_a")
    expect(row?.text).toBe("second")
    const all = await getDb().chatDrafts.toArray()
    expect(all).toHaveLength(1)
  })

  it("increments the shared revision and records safe attachment references", async () => {
    await setDraft("ses_a", "first", [
      { name: "notes.md", mediaType: "text/markdown", size: 42, bytes: new Uint8Array([1]) },
    ])
    const first = await getDraft("ses_a")
    await new Promise((resolve) => setTimeout(resolve, 1))
    await setDraft("ses_a", "second", [], { originClientId: "desktop-client" })

    const second = await getDraft("ses_a")
    expect(second).toMatchObject({
      originClientId: "desktop-client",
      attachmentRefs: [],
    })
    expect(second!.revision).toBe(first!.revision! + 1)
  })

  it("persists an attached draft action before keeping device-local attachment bytes", async () => {
    const accountId = "acct-draft"
    const targetId = "desktop-draft"
    const sessionId = "ses_attached"
    setActiveRuntimeTargetContext(accountId, targetId)
    setRuntimeSnapshot({
      target: { id: targetId, kind: "companion", platform: "web", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "offline",
      host: { compatible: true, operations: ["host_state_submit"], grants: [] },
    })
    const channel = sessionStateChannel(targetId, sessionId)
    await getDb().hostStateChannels.put({
      channel,
      hostId: "host-draft",
      hostGeneration: 3,
      hostSeq: 4,
      revision: 5,
      digest: "digest",
      state: createEmptyHostStateSession(targetId, sessionId),
      updatedAt: 1,
    })
    const bytes = new Uint8Array([1, 2])

    await setDraft(sessionId, "shared", [
      { name: "note.txt", mediaType: "text/plain", size: 2, bytes },
    ])

    const actionRow = (await getDb().mobileOutboundQueue.toArray()).find(
      (row) => row.protocol === "host-state"
    )
    expect(actionRow).toMatchObject({ status: "pending", baseRevision: 5 })
    expect(actionRow?.payload).toMatchObject({
      actions: [
        expect.objectContaining({
          action: {
            kind: "draft.replace",
            text: "shared",
            attachments: [{ name: "note.txt", mediaType: "text/plain", size: 2 }],
          },
        }),
      ],
    })
    expect(Object.values((await getDraft(sessionId))?.attachments?.[0]?.bytes ?? {})).toEqual([
      1, 2,
    ])

    await clearDraft(sessionId, { hostAlreadyCleared: true })
    expect(await getDb().mobileOutboundQueue.count()).toBe(1)
  })

  it("continues the row's revision instead of regressing below an authority write", async () => {
    // The HostState authority advances the shared draft revision out of band.
    await setDraft("ses_a", "from mobile", [], { revision: 41, originClientId: "mobile-a" })
    expect((await getDraft("ses_a"))?.revision).toBe(41)

    // A purely local composer save must continue that sequence, never restart
    // from a clock reading that lands underneath it.
    await setDraft("ses_a", "typed locally")
    expect((await getDraft("ses_a"))?.revision).toBe(42)
  })

  it("does not reuse a revision across concurrent local saves", async () => {
    await setDraft("ses_a", "seed")
    await Promise.all([setDraft("ses_a", "one"), setDraft("ses_a", "two")])
    expect((await getDraft("ses_a"))?.revision).toBe(3)
  })

  it("setDraft keeps drafts isolated per sessionId", async () => {
    await setDraft("ses_a", "alpha")
    await setDraft("ses_b", "beta")
    expect((await getDraft("ses_a"))?.text).toBe("alpha")
    expect((await getDraft("ses_b"))?.text).toBe("beta")
  })

  it("setDraft with empty string clears the row", async () => {
    await setDraft("ses_a", "hello")
    expect(await getDraft("ses_a")).not.toBeNull()
    await setDraft("ses_a", "")
    expect(await getDraft("ses_a")).toBeNull()
  })

  it("setDraft round-trips attachment metadata", async () => {
    await setDraft("ses_a", "look at this", [
      { name: "shot.png", mediaType: "image/png", size: 1234 },
    ])
    const row = await getDraft("ses_a")
    expect(row?.text).toBe("look at this")
    expect(row?.attachments).toEqual([{ name: "shot.png", mediaType: "image/png", size: 1234 }])
  })

  it("setDraft keeps an attachment-only draft (empty text but staged files)", async () => {
    await setDraft("ses_a", "", [{ name: "a.png", mediaType: "image/png", size: 1 }])
    const row = await getDraft("ses_a")
    expect(row).not.toBeNull()
    expect(row?.text).toBe("")
    expect(row?.attachments).toHaveLength(1)
  })

  it("setDraft clears the row only when BOTH text and attachments are empty", async () => {
    await setDraft("ses_a", "hi", [{ name: "a.png", mediaType: "image/png", size: 1 }])
    await setDraft("ses_a", "", [])
    expect(await getDraft("ses_a")).toBeNull()
  })

  it("setDraft omits the attachments field for a text-only draft", async () => {
    await setDraft("ses_a", "just text")
    const row = await getDraft("ses_a")
    expect(row?.text).toBe("just text")
    expect(row?.attachments).toBeUndefined()
  })

  it("clearDraft removes the row", async () => {
    await setDraft("ses_a", "hello")
    await clearDraft("ses_a")
    expect(await getDraft("ses_a")).toBeNull()
  })

  it("clearDraft is a no-op for missing rows", async () => {
    await expect(clearDraft("ses_missing")).resolves.toBeUndefined()
  })

  it("clearDraft cancels a pending debounced write (no stale resurrection)", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "stale text", [], 500)
      // Clear before the debounce fires — must also cancel the pending timer,
      // otherwise the write lands after the delete and the draft reappears.
      await clearDraft("ses_a")
      jest.advanceTimersByTime(500)
      jest.useRealTimers()
      await flushDebouncedDraftWrites()
      expect(await getDraft("ses_a")).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("setDraftDebounced delays the write until flush", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "typing", [], 500)
      expect(await getDraft("ses_a")).toBeNull()
      jest.advanceTimersByTime(499)
      await Promise.resolve()
      expect(await getDraft("ses_a")).toBeNull()
      jest.advanceTimersByTime(1)
      jest.useRealTimers()
      await flushDebouncedDraftWrites()
      const row = await getDraft("ses_a")
      expect(row?.text).toBe("typing")
    } finally {
      jest.useRealTimers()
    }
  })

  it("setDraftDebounced persists the attachments passed to the latest call", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced(
        "ses_a",
        "caption",
        [{ name: "p.png", mediaType: "image/png", size: 9 }],
        500
      )
      jest.advanceTimersByTime(500)
      jest.useRealTimers()
      await flushDebouncedDraftWrites()
      const row = await getDraft("ses_a")
      expect(row?.attachments).toEqual([{ name: "p.png", mediaType: "image/png", size: 9 }])
    } finally {
      jest.useRealTimers()
    }
  })

  it("setDraftDebounced coalesces rapid calls into the latest value", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "v1", [], 500)
      jest.advanceTimersByTime(100)
      setDraftDebounced("ses_a", "v2", [], 500)
      jest.advanceTimersByTime(100)
      setDraftDebounced("ses_a", "v3", [], 500)
      jest.advanceTimersByTime(500)
      jest.useRealTimers()
      await flushDebouncedDraftWrites()
      const row = await getDraft("ses_a")
      expect(row?.text).toBe("v3")
    } finally {
      jest.useRealTimers()
    }
  })

  it("setDraftDebounced uses a per-session timer (separate sessions don't cross-cancel)", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "alpha", [], 500)
      setDraftDebounced("ses_b", "beta", [], 500)
      jest.advanceTimersByTime(500)
      jest.useRealTimers()
      await flushDebouncedDraftWrites()
      expect((await getDraft("ses_a"))?.text).toBe("alpha")
      expect((await getDraft("ses_b"))?.text).toBe("beta")
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("draft attachment binaries + quota", () => {
  // A token payload. `size` is what the quota accounting reads (deliberately —
  // see `rowBytes`), so a test can declare a huge attachment without allocating
  // one; the jest structuredClone polyfill is JSON-based and cannot survive a
  // multi-megabyte typed array.
  const bytesOf = () => new Uint8Array([1, 2, 3, 4])

  it("round-trips the binary and the cached extraction", async () => {
    await setDraft("ses_a", "note", [
      {
        name: "a.png",
        mediaType: "image/png",
        size: 64,
        bytes: bytesOf(),
        extractedText: "body",
        tokens: 7,
      },
    ])
    const row = await getDraft("ses_a")
    const att = row!.attachments![0]!
    expect(att.bytes).toBeDefined()
    expect(att.size).toBe(64)
    expect(att.extractedText).toBe("body")
    expect(att.tokens).toBe(7)
  })

  it("leaves everything alone while under the quota", async () => {
    await setDraft("ses_a", "x", [
      { name: "a.png", mediaType: "image/png", size: 8, bytes: bytesOf() },
    ])
    await enforceDraftAttachmentQuota()
    expect((await getDraft("ses_a"))!.attachments![0]!.bytes).toBeDefined()
  })

  it("evicts the oldest session's binaries first, keeping its metadata", async () => {
    const big = Math.ceil(DRAFT_ATTACHMENT_QUOTA_BYTES * 0.6)
    await setDraft("ses_old", "old", [
      { name: "old.png", mediaType: "image/png", size: big, bytes: bytesOf() },
    ])
    // Force a strictly later `updatedAt` so ordering is unambiguous.
    await getDb().chatDrafts.update("ses_old", { updatedAt: 1 })
    await setDraft("ses_new", "new", [
      { name: "new.png", mediaType: "image/png", size: big, bytes: bytesOf() },
    ])

    await enforceDraftAttachmentQuota()

    const oldRow = await getDraft("ses_old")
    const newRow = await getDraft("ses_new")
    // Oldest loses its binary but degrades to a reminder chip, not deletion.
    expect(oldRow!.attachments![0]!.bytes).toBeUndefined()
    expect(oldRow!.attachments![0]!.name).toBe("old.png")
    expect(oldRow!.attachments![0]!.size).toBe(big)
    expect(newRow!.attachments![0]!.bytes).toBeDefined()
  })

  it("never evicts the session that was just written", async () => {
    const big = Math.ceil(DRAFT_ATTACHMENT_QUOTA_BYTES * 0.6)
    await setDraft("ses_a", "a", [
      { name: "a.png", mediaType: "image/png", size: big, bytes: bytesOf() },
    ])
    await getDb().chatDrafts.update("ses_a", { updatedAt: 1 })
    // `setDraft` enforces the quota itself, protecting the row it just wrote.
    await setDraft("ses_b", "b", [
      { name: "b.png", mediaType: "image/png", size: big, bytes: bytesOf() },
    ])
    expect((await getDraft("ses_b"))!.attachments![0]!.bytes).toBeDefined()
    expect((await getDraft("ses_a"))!.attachments![0]!.bytes).toBeUndefined()
  })

  it("skips rows that carry no binary when freeing space", async () => {
    await setDraft("ses_meta", "meta-only", [{ name: "m.txt", mediaType: "text/plain", size: 3 }])
    const big = DRAFT_ATTACHMENT_QUOTA_BYTES + 1
    await setDraft("ses_big", "big", [
      { name: "b.png", mediaType: "image/png", size: big, bytes: bytesOf() },
    ])
    await enforceDraftAttachmentQuota()
    // The metadata-only row is untouched — there was nothing to reclaim.
    expect((await getDraft("ses_meta"))!.attachments![0]!.name).toBe("m.txt")
  })
})

describe("draft template binding", () => {
  const binding = {
    templateId: "user.chat.review",
    version: "1.2.0",
    params: { module: { kind: "text" as const, value: "login" } },
    insertedAt: 1,
  }

  it("stores the binding alongside the text", async () => {
    await setDraft("s-bind", "review {{module}}", [], { templateBinding: binding })

    await expect(getDraft("s-bind")).resolves.toMatchObject({ templateBinding: binding })
  })

  it("preserves the binding on a plain text save", async () => {
    // The composer's persist effect fires on every keystroke with text and
    // attachments only. If an omitted binding cleared, typing one character
    // would erase every parameter value in the draft.
    await setDraft("s-bind", "review {{module}}", [], { templateBinding: binding })
    await setDraft("s-bind", "review {{module}} now", [])

    await expect(getDraft("s-bind")).resolves.toMatchObject({
      text: "review {{module}} now",
      templateBinding: binding,
    })
  })

  it("clears the binding when explicitly passed null", async () => {
    await setDraft("s-bind", "review {{module}}", [], { templateBinding: binding })
    await setDraft("s-bind", "plain prose", [], { templateBinding: null })

    const row = await getDraft("s-bind")
    expect(row?.text).toBe("plain prose")
    expect(row?.templateBinding).toBeUndefined()
  })

  it("drops the binding with the row when the draft empties out", async () => {
    await setDraft("s-bind", "review {{module}}", [], { templateBinding: binding })
    await setDraft("s-bind", "", [])

    await expect(getDraft("s-bind")).resolves.toBeNull()
  })

  it("carries the binding through a debounced save", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("s-bind", "review {{module}}", [], 500, { templateBinding: binding })
      jest.advanceTimersByTime(500)
      jest.useRealTimers()
      await flushDebouncedDraftWrites()

      await expect(getDraft("s-bind")).resolves.toMatchObject({ templateBinding: binding })
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("draft folded links", () => {
  const links = { "svenstaro/genact": "https://github.com/svenstaro/genact" }

  it("stores the label → URL map alongside the text", async () => {
    await setDraft("s-link", "look at svenstaro/genact", [], { foldedLinks: links })

    await expect(getDraft("s-link")).resolves.toMatchObject({ foldedLinks: links })
  })

  it("preserves the map on a save that does not mention it", async () => {
    await setDraft("s-link", "look at svenstaro/genact", [], { foldedLinks: links })
    await setDraft("s-link", "look at svenstaro/genact now", [])

    await expect(getDraft("s-link")).resolves.toMatchObject({ foldedLinks: links })
  })

  it("clears the map when an empty one is passed", async () => {
    // The composer passes its live map on every save, so deleting the last link
    // has to actually clear the row — otherwise a stale label would expand into
    // a URL the user removed.
    await setDraft("s-link", "look at svenstaro/genact", [], { foldedLinks: links })
    await setDraft("s-link", "no links here", [], { foldedLinks: {} })

    const row = await getDraft("s-link")
    expect(row?.text).toBe("no links here")
    expect(row?.foldedLinks).toBeUndefined()
  })
})
