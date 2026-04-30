// Verifies that applyBackupPackage applies the v3 payload to the local Dexie
// database under each merge strategy, respects built-ins, and handles the
// non-`id`-keyed tables (trustedWorkspaces / sessionState / ttsProviderKeys).

import "fake-indexeddb/auto"
import { applyBackupPackage } from "./apply-package"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import type { BackupPackageV3, BackupPayloadV3 } from "./types"

function pkg(payload: BackupPayloadV3): BackupPackageV3 {
  return {
    version: "3.0",
    manifest: {
      version: "3.0",
      schemaVersion: 3,
      traceId: "t",
      exportedAt: "2024-01-01T00:00:00.000Z",
      appVersion: "0.1.0",
      backend: "web-dexie",
      integrity: { algorithm: "SHA-256", checksum: "" },
    },
    payload,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  const db = getDb()
  await whenSeeded()
  // Wipe seeded built-ins so each test controls its own initial state.
  await Promise.all([
    db.characters.clear(),
    db.skills.clear(),
    db.teams.clear(),
    db.skillResources.clear(),
  ])
})

describe("applyBackupPackage — merge strategies", () => {
  it("'skip' keeps the local row and counts the import row as skipped", async () => {
    const db = getDb()
    await db.promptPresets.put({
      id: "p1",
      name: "local",
      content: "L",
      createdAt: 1,
      updatedAt: 1,
    })
    const summary = await applyBackupPackage(
      pkg({
        promptPresets: [
          { id: "p1", name: "remote", content: "R", createdAt: 2, updatedAt: 2 },
          { id: "p2", name: "fresh", content: "X", createdAt: 3, updatedAt: 3 },
        ],
      }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false }
    )
    const row = await db.promptPresets.get("p1")
    expect(row?.name).toBe("local")
    expect(summary.added.promptPresets).toBe(1)
    expect(summary.skipped.promptPresets).toBe(1)
  })

  it("'overwrite' replaces the local row by id", async () => {
    const db = getDb()
    await db.promptPresets.put({
      id: "p1",
      name: "local",
      content: "L",
      createdAt: 1,
      updatedAt: 1,
    })
    const summary = await applyBackupPackage(
      pkg({
        promptPresets: [{ id: "p1", name: "remote", content: "R", createdAt: 2, updatedAt: 2 }],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    const row = await db.promptPresets.get("p1")
    expect(row?.name).toBe("remote")
    expect(summary.overwritten.promptPresets).toBe(1)
  })

  it("'duplicate' assigns a fresh id and clears isBuiltIn on the duplicate", async () => {
    const db = getDb()
    await db.skills.put({
      id: "s1",
      name: "local",
      content: "L",
      isBuiltIn: false,
      createdAt: 1,
      updatedAt: 1,
    })
    await applyBackupPackage(
      pkg({
        skills: [
          {
            id: "s1",
            name: "remote",
            content: "R",
            isBuiltIn: true,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      }),
      { mergeStrategy: "duplicate", includeSessions: false, includeApiKey: false }
    )
    const all = await db.skills.toArray()
    expect(all).toHaveLength(2)
    const dupe = all.find((s) => s.id !== "s1")!
    expect(dupe.id).not.toBe("s1")
    expect(dupe.isBuiltIn).toBe(false) // stripped on duplicate
  })

  it("never overwrites a local built-in regardless of strategy", async () => {
    const db = getDb()
    await db.characters.put({
      id: "c1",
      name: "Built",
      avatarColor: "oklch(0 0 0)",
      systemPrompt: "x",
      isBuiltIn: true,
      createdAt: 1,
      updatedAt: 1,
    })
    const summary = await applyBackupPackage(
      pkg({
        characters: [
          {
            id: "c1",
            name: "Hijack",
            avatarColor: "oklch(0 0 0)",
            systemPrompt: "y",
            isBuiltIn: false,
            createdAt: 9,
            updatedAt: 9,
          },
        ],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    const row = await db.characters.get("c1")
    expect(row?.name).toBe("Built")
    expect(summary.builtInsSkipped.characters).toBe(1)
  })
})

describe("settings merge", () => {
  it("adds when no local row, overwrites when present and strategy != skip", async () => {
    const db = getDb()
    const noLocal = await applyBackupPackage(
      pkg({ settings: { id: "singleton", alwaysAllowTools: ["Read"] } }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false }
    )
    expect(noLocal.added.settings).toBe(1)
    expect((await db.settings.get("singleton"))?.alwaysAllowTools).toEqual(["Read"])

    const withLocal = await applyBackupPackage(
      pkg({ settings: { id: "singleton", alwaysAllowTools: ["Write"] } }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect(withLocal.overwritten.settings).toBe(1)
    expect((await db.settings.get("singleton"))?.alwaysAllowTools).toEqual(["Write"])
  })

  it("strips the API key unless includeApiKey is true", async () => {
    const db = getDb()
    await applyBackupPackage(
      pkg({ settings: { id: "singleton", alwaysAllowTools: [], apiKey: "secret" } }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect((await db.settings.get("singleton"))?.apiKey).toBeUndefined()
    await applyBackupPackage(
      pkg({ settings: { id: "singleton", alwaysAllowTools: [], apiKey: "secret" } }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: true }
    )
    expect((await db.settings.get("singleton"))?.apiKey).toBe("secret")
  })

  it("counts as skipped when strategy=skip and a local settings row exists", async () => {
    const db = getDb()
    await db.settings.put({ id: "singleton", alwaysAllowTools: ["A"] })
    const summary = await applyBackupPackage(
      pkg({ settings: { id: "singleton", alwaysAllowTools: ["B"] } }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false }
    )
    expect(summary.skipped.settings).toBe(1)
    expect((await db.settings.get("singleton"))?.alwaysAllowTools).toEqual(["A"])
  })
})

describe("non-id-keyed tables", () => {
  it("trustedWorkspaces — keyed by path, skip respects local, overwrite replaces", async () => {
    const db = getDb()
    await db.trustedWorkspaces.put({ path: "/x", trustedAt: 1, note: "old" })
    const skipSummary = await applyBackupPackage(
      pkg({ trustedWorkspaces: [{ path: "/x", trustedAt: 2, note: "new" }] }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false }
    )
    expect(skipSummary.skipped.trustedWorkspaces).toBe(1)
    expect((await db.trustedWorkspaces.get("/x"))?.note).toBe("old")

    const overSummary = await applyBackupPackage(
      pkg({ trustedWorkspaces: [{ path: "/x", trustedAt: 2, note: "new" }] }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect(overSummary.overwritten.trustedWorkspaces).toBe(1)
    expect((await db.trustedWorkspaces.get("/x"))?.note).toBe("new")
  })

  it("ttsProviderKeys — keyed by id, fresh path counts as added", async () => {
    const summary = await applyBackupPackage(
      pkg({ ttsProviderKeys: [{ id: "tts.providerKey.openai", value: "sk-1" }] }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false }
    )
    expect(summary.added.ttsProviderKeys).toBe(1)
  })
})

describe("sessions slice", () => {
  it("ignores sessions/messages/sessionState when includeSessions=false", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg({
        sessions: [{ id: "s1", title: "x", createdAt: 1, updatedAt: 1 }],
        messages: [{ id: "m1", sessionId: "s1", role: "user", parts: [], createdAt: 1 }],
        sessionState: [{ sessionId: "s1", lastReadAt: 1, unreadCount: 0 }],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect(await db.sessions.count()).toBe(0)
    expect(summary.added.sessions).toBeUndefined()
  })

  it("applies the sessions slice when includeSessions=true", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg({
        sessions: [{ id: "s1", title: "x", createdAt: 1, updatedAt: 1 }],
        messages: [{ id: "m1", sessionId: "s1", role: "user", parts: [], createdAt: 1 }],
        sessionState: [{ sessionId: "s1", lastReadAt: 1, unreadCount: 0 }],
      }),
      { mergeStrategy: "overwrite", includeSessions: true, includeApiKey: false }
    )
    expect(await db.sessions.count()).toBe(1)
    expect(await db.messages.count()).toBe(1)
    expect(await db.sessionState.count()).toBe(1)
    expect(summary.added.sessions).toBe(1)
    expect(summary.added.messages).toBe(1)
    expect(summary.added.sessionState).toBe(1)
  })
})

describe("empty / missing collections", () => {
  it("returns an empty summary when payload has no rows", async () => {
    const summary = await applyBackupPackage(pkg({}), {
      mergeStrategy: "skip",
      includeSessions: true,
      includeApiKey: false,
    })
    expect(summary.added).toEqual({})
    expect(summary.overwritten).toEqual({})
    expect(summary.skipped).toEqual({})
    expect(summary.builtInsSkipped).toEqual({})
  })
})
