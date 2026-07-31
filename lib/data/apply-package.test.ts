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
  it("validates and restores the secret-free Provider Profile Store", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg({
        providerProfileStore: {
          schemaVersion: 2,
          profileVersion: 4,
          providerProfiles: [{ id: "openai", displayName: "OpenAI", deploymentRefs: ["openai"] }],
          deploymentProfiles: [
            {
              id: "openai",
              providerRef: "openai",
              endpoint: "https://api.openai.com/v1",
              transportProfileRef: "tp-openai",
              credentialProfileRef: {
                kind: "legacy-provider-settings",
                providerId: "openai",
              },
              models: [
                {
                  id: "gpt-5",
                  upstreamId: "gpt-5",
                  canonicalModelRef: "openai:gpt-5",
                  offeringRef: "openai:gpt-5",
                },
              ],
            },
          ],
          transportProfiles: [{ id: "tp-openai", protocol: "openai", auth: { scheme: "bearer" } }],
          legacyAliases: { openai: "openai" },
        },
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )

    expect(await db.providerProfiles.get("openai")).toMatchObject({ displayName: "OpenAI" })
    expect(await db.deploymentProfiles.get("openai")).toMatchObject({
      providerRef: "openai",
      models: [{ upstreamId: "gpt-5", offeringRef: "openai:gpt-5" }],
    })
    expect(await db.transportProfiles.get("tp-openai")).toBeDefined()
    expect(await db.profileStoreMeta.get("singleton")).toMatchObject({
      schemaVersion: 2,
    })
    expect(summary.added).toMatchObject({
      providerProfiles: 1,
      deploymentProfiles: 1,
      transportProfiles: 1,
    })
  })

  it("rejects Provider Profile Store payloads containing secret material", async () => {
    const db = getDb()

    await expect(
      applyBackupPackage(
        pkg({
          providerProfileStore: {
            schemaVersion: 2,
            profileVersion: 1,
            providerProfiles: [
              {
                id: "unsafe",
                displayName: "Unsafe",
                deploymentRefs: [],
                apiKey: "sk-should-not-import",
              } as never,
            ],
            deploymentProfiles: [],
            transportProfiles: [],
            legacyAliases: {},
          },
        }),
        { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
      )
    ).rejects.toThrow("secret material is not allowed")
    expect(await db.providerProfiles.get("unsafe")).toBeUndefined()
  })

  it("restores portable template rows without accepting device bindings", async () => {
    const db = getDb()
    await applyBackupPackage(
      pkg({
        templateDefinitions: [
          {
            storageKey: "draft:skill.restore",
            apiVersion: "cognia.ai/templates/v1",
            id: "skill.restore",
            domain: "skill",
            status: "draft",
            revision: 1,
            version: null,
            metadata: { name: "Restore" },
            payload: { content: "x" },
            inputs: [],
            dependencies: [],
            capabilities: [],
            compatibility: { platforms: ["desktop"] },
            provenance: { source: "user" },
            contentHash: "b".repeat(64),
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false }
    )

    expect(await db.templateDefinitions.get("draft:skill.restore")).toBeDefined()
    expect(await db.templateDeviceBindings.toArray()).toEqual([])
  })

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

  it("'duplicate' strategy retains every plugin child row under the fresh plugin id", async () => {
    const db = getDb()
    await db.plugins.put(pluginRow({ id: "plg-dup", name: "local" }))

    const summary = await applyBackupPackage(
      pkg({
        plugins: [pluginRow({ id: "plg-dup", name: "remote" })],
        pluginPermissions: [
          {
            pluginId: "plg-dup",
            permission: "clipboard:read",
            decision: "allow",
            grantedAt: 1,
          },
        ],
        pluginReviews: [{ pluginId: "plg-dup", id: "review-1", rating: 5, createdAt: 1 }],
        pluginAnalytics: [{ pluginId: "plg-dup", key: "tool.invoke", count: 5, lastEventAt: 1 }],
      }),
      { mergeStrategy: "duplicate", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )

    const duplicate = (await db.plugins.toArray()).find((row) => row.id !== "plg-dup")
    expect(duplicate).toBeDefined()
    const duplicateId = duplicate!.id
    expect(await db.pluginPermissions.where("pluginId").equals(duplicateId).toArray()).toEqual([
      {
        pluginId: duplicateId,
        permission: "clipboard:read",
        decision: "allow",
        grantedAt: 1,
      },
    ])
    expect(await db.pluginReviews.where("pluginId").equals(duplicateId).toArray()).toEqual([
      { pluginId: duplicateId, id: "review-1", rating: 5, createdAt: 1 },
    ])
    expect(await db.pluginAnalytics.where("pluginId").equals(duplicateId).toArray()).toEqual([
      { pluginId: duplicateId, key: "tool.invoke", count: 5, lastEventAt: 1 },
    ])
    expect(summary.added.pluginPermissions).toBe(1)
    expect(summary.added.pluginReviews).toBe(1)
    expect(summary.added.pluginAnalytics).toBe(1)
  })

  it("imports permissions, reviews, and analytics only for imported plugin ids", async () => {
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
        pluginReviews: [
          { pluginId: "plg-with-data", id: "review-1", rating: 5, createdAt: 1 },
          { pluginId: "plg-orphan", id: "review-2", rating: 1, createdAt: 1 },
        ],
      }),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    expect(await db.pluginPermissions.toArray()).toHaveLength(1)
    expect(await db.pluginReviews.toArray()).toHaveLength(1)
    expect(await db.pluginAnalytics.toArray()).toHaveLength(1)
    expect(summary.added.pluginPermissions).toBe(1)
    expect(summary.added.pluginReviews).toBe(1)
    expect(summary.added.pluginAnalytics).toBe(1)
  })

  it("ignores the retired pluginScheduledJobs field in legacy backups", async () => {
    const legacyPayload = {
      plugins: [pluginRow({ id: "plg-legacy" })],
      pluginScheduledJobs: [
        {
          id: "legacy-job",
          pluginId: "plg-legacy",
          cron: "0 * * * *",
          handler: "tick",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }

    await expect(
      applyBackupPackage(
        pkg(legacyPayload as never),
        { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
        { projectMcp: async () => [] }
      )
    ).resolves.toBeDefined()
    expect(await getDb().plugins.get("plg-legacy")).toBeDefined()
    expect(getDb().tables.map((table) => table.name)).not.toContain("pluginScheduledJobs")
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

describe("applyBackupPackage — learned memory", () => {
  function memorySnapshot(): BackupPayloadV3 {
    return {
      memories: [
        {
          id: "mem_1",
          scope: "workspace",
          projectId: "project_1",
          type: "semantic",
          text: "The project uses pnpm.",
          tags: ["tooling"],
          importance: 8,
          createdAt: 1,
          updatedAt: 1,
          lastAccessedAt: 1,
          accessCount: 0,
          version: 1,
          status: "active",
          pinned: false,
          provenance: "user",
          evidenceState: "supported",
          reviewStatus: "verified",
          contaminationState: "clean",
          sensitivity: "normal",
        },
      ],
      memoryEvidence: [
        {
          id: "mev_1",
          memoryId: "mem_1",
          kind: "message",
          sourceId: "source_1",
          contaminationState: "clean",
          reviewed: true,
          createdAt: 1,
        },
      ],
      memoryJobs: [
        {
          id: "mjob_1",
          dedupeKey: "turn:s1:m1",
          kind: "turn-extraction",
          status: "completed",
          scope: "workspace",
          projectId: "project_1",
          provenance: "user",
          evidenceIds: ["mev_1"],
          queuedAt: 1,
          completedAt: 2,
          retryCount: 0,
        },
      ],
      memoryAuditEvents: [
        {
          id: "maudit_1",
          action: "created",
          memoryId: "mem_1",
          reason: "turn-extraction",
          createdAt: 2,
        },
      ],
    }
  }

  it("restores the complete memory provenance graph", async () => {
    const db = getDb()
    const summary = await applyBackupPackage(
      pkg(memorySnapshot()),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )

    expect((await db.memoryEvidence.get("mev_1"))?.memoryId).toBe("mem_1")
    expect((await db.memoryJobs.get("mjob_1"))?.evidenceIds).toEqual(["mev_1"])
    expect((await db.memoryAuditEvents.get("maudit_1"))?.memoryId).toBe("mem_1")
    expect(summary.added.memories).toBe(1)
    expect(summary.added.memoryEvidence).toBe(1)
    expect(summary.added.memoryJobs).toBe(1)
    expect(summary.added.memoryAuditEvents).toBe(1)
  })

  it("remaps child references when duplicate import ids collide", async () => {
    const db = getDb()
    await applyBackupPackage(
      pkg(memorySnapshot()),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    await applyBackupPackage(
      pkg(memorySnapshot()),
      { mergeStrategy: "duplicate", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )

    const memories = await db.memories.toArray()
    const duplicateMemory = memories.find((row) => row.id !== "mem_1")
    const evidence = (await db.memoryEvidence.toArray()).find((row) => row.id !== "mev_1")
    const job = (await db.memoryJobs.toArray()).find((row) => row.id !== "mjob_1")
    const audit = (await db.memoryAuditEvents.toArray()).find((row) => row.id !== "maudit_1")

    expect(duplicateMemory).toBeDefined()
    expect(evidence?.memoryId).toBe(duplicateMemory?.id)
    expect(job?.evidenceIds).toEqual([evidence?.id])
    expect(audit?.memoryId).toBe(duplicateMemory?.id)
  })

  it("remaps supersession and conflict links inside duplicated memory rows", async () => {
    const db = getDb()
    const snapshot = memorySnapshot()
    snapshot.memories!.push({
      ...snapshot.memories![0],
      id: "mem_2",
      text: "The project uses npm.",
      reviewStatus: "conflict",
      conflictWithIds: ["mem_1"],
    })
    snapshot.memories![0] = {
      ...snapshot.memories![0],
      supersededById: "mem_2",
      conflictWithIds: ["mem_2"],
    }
    await applyBackupPackage(
      pkg(snapshot),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    await applyBackupPackage(
      pkg(snapshot),
      { mergeStrategy: "duplicate", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )
    const duplicated = (await db.memories.toArray()).filter(
      (row) => row.id !== "mem_1" && row.id !== "mem_2"
    )
    const first = duplicated.find((row) => row.text === "The project uses pnpm.")
    const second = duplicated.find((row) => row.text === "The project uses npm.")
    expect(first?.supersededById).toBe(second?.id)
    expect(first?.conflictWithIds).toEqual([second?.id])
    expect(second?.conflictWithIds).toEqual([first?.id])
  })

  it("validates imported governance rows and redacts memory text before persistence", async () => {
    const db = getDb()
    const snapshot = memorySnapshot()
    snapshot.memories![0] = {
      ...snapshot.memories![0],
      text: "Email alice@example.com about pnpm",
    }
    snapshot.memoryAuditEvents![0] = {
      ...snapshot.memoryAuditEvents![0],
      reason: "alice@example.com",
      metadata: { safeCount: 1, leaked: "bob@example.com" },
    }
    snapshot.memoryEvidence!.push({ invalid: true } as never)

    const summary = await applyBackupPackage(
      pkg(snapshot),
      { mergeStrategy: "overwrite", includeSessions: false, includeApiKey: false },
      { projectMcp: async () => [] }
    )

    const memory = await db.memories.get("mem_1")
    expect(memory?.text).not.toContain("alice@example.com")
    expect(memory?.text).toContain("<EMAIL_")
    expect(await db.memoryEvidence.count()).toBe(1)
    expect(summary.added.memoryEvidence).toBe(1)
    expect(await db.memoryAuditEvents.get("maudit_1")).toMatchObject({
      reason: "imported",
      metadata: { safeCount: 1 },
    })
  })
})
