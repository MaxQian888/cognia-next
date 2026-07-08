/** @jest-environment jsdom */
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
      pkg({
        settings: {
          id: "singleton",
          alwaysAllowTools: ["Read"],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
        },
      }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false }
    )
    expect(noLocal.added.settings).toBe(1)
    expect((await db.settings.get("singleton"))?.alwaysAllowTools).toEqual(["Read"])

    const withLocal = await applyBackupPackage(
      pkg({
        settings: {
          id: "singleton",
          alwaysAllowTools: ["Write"],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect(withLocal.overwritten.settings).toBe(1)
    expect((await db.settings.get("singleton"))?.alwaysAllowTools).toEqual(["Write"])
  })

  it("strips the API key unless includeApiKey is true", async () => {
    const db = getDb()
    await applyBackupPackage(
      pkg({
        settings: {
          id: "singleton",
          alwaysAllowTools: [],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
          apiKey: "secret",
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect((await db.settings.get("singleton"))?.apiKey).toBeUndefined()
    await applyBackupPackage(
      pkg({
        settings: {
          id: "singleton",
          alwaysAllowTools: [],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
          apiKey: "secret",
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: true }
    )
    expect((await db.settings.get("singleton"))?.apiKey).toBe("secret")
  })

  it("preserves onboardingDismissedAt across import (never stripped like apiKey)", async () => {
    const db = getDb()
    await applyBackupPackage(
      pkg({
        settings: {
          id: "singleton",
          alwaysAllowTools: [],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
          onboardingDismissedAt: "2026-05-18T12:00:00.000Z",
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )
    expect((await db.settings.get("singleton"))?.onboardingDismissedAt).toBe(
      "2026-05-18T12:00:00.000Z"
    )
  })

  it("counts as skipped when strategy=skip and a local settings row exists", async () => {
    const db = getDb()
    await db.settings.put({
      id: "singleton",
      alwaysAllowTools: ["A"],
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
      },
    })
    const summary = await applyBackupPackage(
      pkg({
        settings: {
          id: "singleton",
          alwaysAllowTools: ["B"],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
        },
      }),
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

describe("applyBackupPackage — localStorage snapshot face", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear()
  })

  it("writes localStorageSnapshots into the snapshot registry's storage", async () => {
    const summary = await applyBackupPackage(
      pkg({
        localStorageSnapshots: {
          "cognia-external-agents": {
            key: "cognia-external-agents",
            storeVersion: 5,
            snapshotFormatVersion: 1,
            raw: { state: { agents: { foo: { id: "foo" } } }, version: 5 },
            capturedAt: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    expect(summary.localStorage?.written).toEqual(["cognia-external-agents"])
    expect(localStorage.getItem("cognia-external-agents")).toContain('"foo"')
  })

  it("includes the syncResults from the injected projector", async () => {
    const summary = await applyBackupPackage(
      pkg({}),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false },
      {
        projectMcp: async () => [
          { agentId: "claude-code", ok: true, count: 2 },
          { agentId: "cursor", ok: false, reason: "not-tauri" },
        ],
      }
    )
    expect(summary.syncResults).toEqual([
      { agentId: "claude-code", ok: true, count: 2 },
      { agentId: "cursor", ok: false, reason: "not-tauri" },
    ])
  })

  it("captures a thrown projector failure into syncResults rather than rejecting", async () => {
    const summary = await applyBackupPackage(
      pkg({}),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false },
      {
        projectMcp: async () => {
          throw new Error("locked")
        },
      }
    )
    expect(summary.syncResults).toEqual([{ agentId: "*", ok: false, reason: "locked" }])
  })

  it("rolls localStorage back to preSnap when a write fails after the Dexie commit", async () => {
    localStorage.setItem(
      "cognia-external-agents",
      JSON.stringify({ state: { agents: { pre: 1 } }, version: 5 })
    )
    // Inject a storage that throws on setItem for one key to simulate a
    // post-commit localStorage write failure.
    const realStorage = window.localStorage
    let setItemCalls = 0
    const failingStorage = {
      getItem: (k: string) => realStorage.getItem(k),
      setItem: (k: string, v: string) => {
        setItemCalls++
        if (k === "cognia-external-agents" && setItemCalls === 1) {
          throw new Error("disk-full")
        }
        realStorage.setItem(k, v)
      },
      removeItem: (k: string) => realStorage.removeItem(k),
    }
    const summary = await applyBackupPackage(
      pkg({
        localStorageSnapshots: {
          "cognia-external-agents": {
            key: "cognia-external-agents",
            storeVersion: 5,
            snapshotFormatVersion: 1,
            raw: { state: { agents: { post: 1 } }, version: 5 },
            capturedAt: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { storage: failingStorage, projectMcp: async () => [] }
    )
    expect(summary.localStorage?.errors[0]?.error).toBe("disk-full")
    expect(summary.localStorage?.restoredFromPreSnap).toContain("cognia-external-agents")
  })
})

describe("applyBackupPackage — plugins domain", () => {
  function pluginRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "plg1",
      name: "Sample plugin",
      version: "1.0.0",
      status: "loaded",
      source: "local",
      type: "frontend",
      enabled: true,
      capabilities: ["tools"],
      path: "builtin://plg1",
      manifest: { id: "plg1" },
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
  }

  it("imports new plugin rows but forces enabled=false", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg({ plugins: [pluginRow({ id: "plg1", enabled: true })] }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    const row = await db.plugins.get("plg1")
    expect(row?.enabled).toBe(false)
    expect(summary.added.plugins).toBe(1)
  })

  it("skips builtin plugins from the import payload", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg({
        plugins: [
          pluginRow({ id: "plg-builtin", source: "builtin" }),
          pluginRow({ id: "plg-user", source: "local" }),
        ],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    expect(await db.plugins.get("plg-builtin")).toBeUndefined()
    expect(await db.plugins.get("plg-user")).toBeDefined()
    expect(summary.builtInsSkipped.plugins).toBe(1)
    expect(summary.added.plugins).toBe(1)
  })

  it("never overwrites a local builtin plugin even when merge=overwrite", async () => {
    const db = getDb()
    await db.plugins.put(pluginRow({ id: "plg-shared", source: "builtin" }))
    const summary = await applyBackupPackage(
      pkg({
        plugins: [pluginRow({ id: "plg-shared", source: "local", name: "remote-overwrite" })],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    const row = await db.plugins.get("plg-shared")
    expect(row?.source).toBe("builtin")
    expect(row?.name).not.toBe("remote-overwrite")
    expect(summary.builtInsSkipped.plugins).toBe(1)
  })

  it("'duplicate' strategy assigns a fresh id and still forces enabled=false", async () => {
    const db = getDb()
    await db.plugins.put(pluginRow({ id: "plg-dup", name: "local", enabled: true }))
    const summary = await applyBackupPackage(
      pkg({ plugins: [pluginRow({ id: "plg-dup", name: "remote", enabled: true })] }),
      { mergeStrategy: "duplicate", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    const all = await db.plugins.toArray()
    expect(all.length).toBe(2)
    const dup = all.find((r) => r.id !== "plg-dup")
    expect(dup?.enabled).toBe(false)
    expect(summary.added.plugins).toBe(1)
  })

  it("imports permissions / scheduled-jobs / analytics only for imported plugin ids", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg({
        plugins: [pluginRow({ id: "plg-with-data" })],
        pluginPermissions: [
          {
            pluginId: "plg-with-data",
            permission: "clipboard:read",
            decision: "allow",
            grantedAt: 1,
          },
          { pluginId: "plg-orphan", permission: "shell:execute", decision: "allow", grantedAt: 1 },
        ],
        pluginAnalytics: [
          { pluginId: "plg-with-data", key: "tool.invoke", count: 5, lastEventAt: 1 },
          { pluginId: "plg-orphan", key: "tool.invoke", count: 5, lastEventAt: 1 },
        ],
        pluginScheduledJobs: [
          {
            id: "j1",
            pluginId: "plg-with-data",
            cron: "0 * * * *",
            handler: "tick",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "j2",
            pluginId: "plg-orphan",
            cron: "0 * * * *",
            handler: "tick",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    expect(await db.pluginPermissions.toArray()).toHaveLength(1)
    expect(await db.pluginAnalytics.toArray()).toHaveLength(1)
    const jobs = await db.pluginScheduledJobs.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.pluginId).toBe("plg-with-data")
    expect(summary.added.pluginPermissions).toBe(1)
    expect(summary.added.pluginAnalytics).toBe(1)
    expect(summary.added.pluginScheduledJobs).toBe(1)
  })

  it("skip strategy preserves local plugin rows", async () => {
    const db = getDb()
    await db.plugins.put(pluginRow({ id: "plg-skip", name: "local", enabled: true }))
    const summary = await applyBackupPackage(
      pkg({ plugins: [pluginRow({ id: "plg-skip", name: "remote" })] }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    const row = await db.plugins.get("plg-skip")
    expect(row?.name).toBe("local")
    // local was enabled so leaving it alone keeps it enabled
    expect(row?.enabled).toBe(true)
    expect(summary.skipped.plugins).toBe(1)
  })
})

describe("applyBackupPackage — twin tables", () => {
  function twinSnapshot(): BackupPayloadV3 {
    return {
      twinSources: [
        {
          id: "tsrc_1",
          twinId: "twin_alice",
          kind: "document",
          format: "markdown",
          source: "manual",
          title: "demo.md",
          bytes: 12,
          fingerprint: "fp",
          chunkCount: 1,
          status: "parsed",
          importedAt: 1,
          redacted: true,
        },
      ],
      twinChunks: [
        {
          id: "tchk_1",
          twinId: "twin_alice",
          sourceId: "tsrc_1",
          content: "hello",
          contentRedacted: "hello",
          charStart: 0,
          charEnd: 5,
          vectorBackend: "qdrant",
          vectorCollection: "cognia_twin_twin_alice",
          vectorDocId: "vec_1",
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
          createdAt: 2,
        },
      ],
      twinProfile: [
        {
          id: "twin_alice",
          twinId: "twin_alice",
          styleSamples: [],
          playbooks: [],
          entities: [],
          decisions: [],
          voiceSummary: "",
          updatedAt: 3,
        },
      ],
      twinDrafts: [
        {
          id: "tdr_1",
          twinId: "twin_alice",
          jobId: "twj_1",
          kind: "skill",
          payload: { kind: "skill", data: { name: "Demo" } },
          provenance: { chunkIds: ["tchk_1"], rationale: "test" },
          status: "pending",
          createdAt: 4,
        },
      ],
      twinJobs: [
        {
          id: "twj_1",
          twinId: "twin_alice",
          kind: "ingest",
          sourceIds: ["tsrc_1"],
          status: "completed",
          phase: "completed",
          progress: 100,
          queuedAt: 5,
          retryCount: 0,
        },
      ],
    }
  }

  it("imports a fresh twin snapshot end to end", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg(twinSnapshot()),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )

    expect(await db.twinSources.toArray()).toHaveLength(1)
    expect(await db.twinChunks.toArray()).toHaveLength(1)
    expect((await db.twinProfile.get("twin_alice"))?.twinId).toBe("twin_alice")
    expect(await db.twinDrafts.toArray()).toHaveLength(1)
    expect(await db.twinJobs.toArray()).toHaveLength(1)

    expect(summary.added.twinSources).toBe(1)
    expect(summary.added.twinChunks).toBe(1)
    expect(summary.added.twinProfile).toBe(1)
    expect(summary.added.twinDrafts).toBe(1)
    expect(summary.added.twinJobs).toBe(1)
  })

  it("twin profile uses overwrite-by-id even with duplicate strategy", async () => {
    const db = getDb()
    // Pre-existing profile for the same twin.
    await db.twinProfile.put({
      id: "twin_alice",
      twinId: "twin_alice",
      styleSamples: [],
      playbooks: [],
      entities: [],
      decisions: [],
      voiceSummary: "OLD",
      updatedAt: 1,
    })
    await applyBackupPackage(
      pkg(twinSnapshot()),
      { mergeStrategy: "duplicate", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    // Profile should still be a single row keyed by twinId — no duplicate.
    expect(await db.twinProfile.toArray()).toHaveLength(1)
    expect((await db.twinProfile.get("twin_alice"))?.voiceSummary).toBe("")
  })

  it("legacy v3 envelopes without twin fields apply cleanly (no errors)", async () => {
    // No twin* properties at all — verifies the importer treats undefined as
    // "no rows to apply" (additive forward-compat).
    const summary = await applyBackupPackage(
      pkg({ promptPresets: [] }),
      { mergeStrategy: "skip", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    expect(summary.added.twinSources).toBeUndefined()
    expect(summary.added.twinJobs).toBeUndefined()
  })
})
