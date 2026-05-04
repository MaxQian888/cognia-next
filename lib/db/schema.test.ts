// Coverage for the schema module — Dexie instance lifecycle, lazy seeding,
// and the test reset helper. Also exercises the v5 (members[]) and v7
// (appsEnabled={}) upgrade hooks indirectly: the seeder runs against a
// freshly opened DB, which means the latest version (12) opens cleanly.

import "fake-indexeddb/auto"
import { CogniaDB, __resetDbForTesting, getDb, whenSeeded } from "./schema"

describe("getDb", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("returns a CogniaDB instance with every advertised table wired", () => {
    const db = getDb()
    expect(db).toBeInstanceOf(CogniaDB)
    expect(db.sessions).toBeDefined()
    expect(db.messages).toBeDefined()
    expect(db.settings).toBeDefined()
    expect(db.promptPresets).toBeDefined()
    expect(db.mcpServers).toBeDefined()
    expect(db.characters).toBeDefined()
    expect(db.skills).toBeDefined()
    expect(db.skillResources).toBeDefined()
    expect(db.teams).toBeDefined()
    expect(db.trustedWorkspaces).toBeDefined()
    expect(db.backupHistory).toBeDefined()
    expect(db.canvasDocuments).toBeDefined()
    expect(db.canvasVersions).toBeDefined()
    expect(db.canvasComments).toBeDefined()
    expect(db.canvasSessions).toBeDefined()
    expect(db.sessionState).toBeDefined()
    expect(db.tts_provider_keys).toBeDefined()
    // §A-Schema (v15) — the five plugin tables added by the plugin port.
    expect(db.plugins).toBeDefined()
    expect(db.pluginPermissions).toBeDefined()
    expect(db.pluginReviews).toBeDefined()
    expect(db.pluginAnalytics).toBeDefined()
    expect(db.pluginScheduledJobs).toBeDefined()
  })

  // §A-Schema migration check: Dexie auto-applies all version blocks up to
  // the latest when the schema bumps. Verify v15 opens cleanly on a fresh
  // database and that we can write/read a row through each new table — that
  // proves both the index declarations and the per-row type compile.
  it("v15 plugin tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.plugins.put({
      id: "p1",
      name: "Test Plugin",
      version: "1.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: ["tools", "commands"],
      path: "<builtin>/p1",
      manifest: { id: "p1", name: "Test Plugin", version: "1.0.0" },
      createdAt: now,
      updatedAt: now,
    })

    await db.pluginPermissions.put({
      pluginId: "p1",
      permission: "shell:execute",
      decision: "allow",
      grantedAt: now,
    })

    await db.pluginReviews.put({
      id: "rev-1",
      pluginId: "p1",
      rating: 5,
      title: "Great",
      createdAt: now,
    })

    await db.pluginAnalytics.put({
      pluginId: "p1",
      key: "tool.git_status.invocations",
      count: 7,
      lastEventAt: now,
    })

    await db.pluginScheduledJobs.put({
      id: "job-1",
      pluginId: "p1",
      cron: "0 * * * *",
      handler: "syncRepo",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })

    expect(await db.plugins.get("p1")).toMatchObject({ name: "Test Plugin", enabled: true })
    expect(await db.pluginPermissions.get(["p1", "shell:execute"])).toMatchObject({
      decision: "allow",
    })
    expect(await db.pluginReviews.get(["p1", "rev-1"])).toMatchObject({ rating: 5 })
    expect(await db.pluginAnalytics.get(["p1", "tool.git_status.invocations"])).toMatchObject({
      count: 7,
    })
    expect(await db.pluginScheduledJobs.get("job-1")).toMatchObject({ status: "active" })
  })

  it("v15 plugin indexes drive filtered queries (multi-entry capabilities)", async () => {
    const db = getDb()
    const now = Date.now()
    await db.plugins.bulkPut([
      {
        id: "a",
        name: "A",
        version: "1",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["tools", "commands"],
        path: "x",
        manifest: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "b",
        name: "B",
        version: "1",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["modes", "themes"],
        path: "x",
        manifest: {},
        createdAt: now,
        updatedAt: now,
      },
    ])

    // The `*capabilities` multi-entry index supports `where("capabilities").equals(...)`
    // queries — exactly the lookup the Settings → Plugins capability filter uses.
    const toolsPlugins = await db.plugins.where("capabilities").equals("tools").toArray()
    expect(toolsPlugins.map((p) => p.id)).toEqual(["a"])
    const themesPlugins = await db.plugins.where("capabilities").equals("themes").toArray()
    expect(themesPlugins.map((p) => p.id)).toEqual(["b"])
  })

  it("returns the same instance on repeat calls (memoised)", () => {
    const a = getDb()
    const b = getDb()
    expect(a).toBe(b)
  })

  it("__resetDbForTesting drops the cached instance", () => {
    const a = getDb()
    __resetDbForTesting()
    const b = getDb()
    expect(a).not.toBe(b)
  })

  // SSR guard (`typeof window === "undefined"`) cannot be exercised under
  // jsdom — `window` is a non-configurable global and `typeof` resolves
  // against the binding regardless of `globalThis.window`. The branch is
  // covered indirectly by every other test calling `getDb()` and observing
  // the "happy path" return value: the false branch of that conditional is
  // hit in every spec. Documenting here so a future maintainer knows why
  // we don't claim to exercise the throw.
})

describe("whenSeeded", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("resolves once and reflects seeded built-in characters", async () => {
    getDb()
    await whenSeeded()
    const built = await getDb().characters.where("isBuiltIn").equals(1).count()
    // Boolean indexing is unreliable across IDB shims; fall back to filter.
    const all = await getDb().characters.toArray()
    const builtIns = all.filter((c) => c.isBuiltIn)
    expect(builtIns.length + built).toBeGreaterThan(0)
  })

  it("returns a resolved promise when no seed run is pending", async () => {
    // Without calling getDb first, _seedPromise is null — whenSeeded must
    // gracefully kick off a seed via getDb(), then resolve.
    await expect(whenSeeded()).resolves.toBeUndefined()
  })
})

describe("schema upgrade hooks (round-trip via the latest version)", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("opens at v12 with the documented promptPresets indexes", async () => {
    const db = getDb()
    // Verify the table is queryable by the new boolean-ish indexes added in v12.
    await db.promptPresets.put({
      id: "p_test",
      name: "T",
      content: "x",
      isBuiltIn: false,
      isFavorite: true,
      sortOrder: 5,
      usageCount: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    const fetched = await db.promptPresets.get("p_test")
    expect(fetched?.isFavorite).toBe(true)
    // Index on sortOrder is queryable
    const ordered = await db.promptPresets.orderBy("sortOrder").toArray()
    expect(ordered.find((p) => p.id === "p_test")?.sortOrder).toBe(5)
  })

  it("v5 upgrade hook normalises legacy team rows (memberCharacterIds → members[])", async () => {
    // Open Dexie at v4 (before the team-shape change), write a legacy row,
    // close, then re-open through the cached `getDb()` which routes through
    // every version up to v12.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })
    await legacy.open()
    await legacy.table("teams").put({
      id: "team_legacy",
      name: "Legacy",
      memberCharacterIds: ["c1", "c2"],
      orchestration: "round_robin",
      avatarColor: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    // Legacy mcpServers row missing appsEnabled — v7 hook should backfill {}
    await legacy.table("mcpServers").put({
      id: "mcp_legacy",
      name: "old",
      enabled: true,
      transport: "stdio",
      config: {},
    })
    // Legacy skills row missing source/status/category — v8 hook backfills.
    await legacy.table("skills").put({
      id: "skill_legacy",
      name: "old",
      content: "x",
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()

    // Now open through the production schema: every upgrade hook runs.
    const db = getDb()
    await db.open()
    const team = await db.teams.get("team_legacy")
    expect(Array.isArray(team?.members)).toBe(true)
    expect(team?.members.map((m) => m.characterId)).toEqual(["c1", "c2"])
    // memberCharacterIds was deleted by the upgrade hook.
    expect((team as unknown as { memberCharacterIds?: unknown }).memberCharacterIds).toBeUndefined()

    const mcp = await db.mcpServers.get("mcp_legacy")
    expect(mcp?.appsEnabled).toEqual({})

    const skill = await db.skills.get("skill_legacy")
    expect(skill?.source).toBe("custom")
    expect(skill?.status).toBe("enabled")
    expect(skill?.category).toBe("custom")
    expect(skill?.usageCount).toBe(0)
  })

  it("v5 hook defaults to [] when memberCharacterIds is missing entirely", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })
    await legacy.open()
    await legacy.table("teams").put({
      id: "team_no_members_field",
      name: "Bare",
      // Neither memberCharacterIds nor members.
      orchestration: "manual",
      avatarColor: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const team = await db.teams.get("team_no_members_field")
    expect(team?.members).toEqual([])
  })

  it("v5 hook leaves rows that already use members[] alone", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(4).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
    })
    await legacy.open()
    await legacy.table("teams").put({
      id: "team_already_modern",
      name: "Modern",
      // Already has members[] — hook must short-circuit.
      members: [{ characterId: "x" }],
      orchestration: "manual",
      avatarColor: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const team = await db.teams.get("team_already_modern")
    expect(team?.members).toEqual([{ characterId: "x" }])
  })

  it("v7 hook leaves mcpServers rows that already have appsEnabled alone", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(6).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
    })
    await legacy.open()
    await legacy.table("mcpServers").put({
      id: "mcp_modern",
      name: "modern",
      enabled: true,
      transport: "stdio",
      config: {},
      appsEnabled: { codex: true },
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const mcp = await db.mcpServers.get("mcp_modern")
    expect(mcp?.appsEnabled).toEqual({ codex: true })
  })

  it("v8 hook respects existing skill source/status/category fields", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(7).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
    })
    await legacy.open()
    await legacy.table("skills").put({
      id: "skill_with_meta",
      name: "withmeta",
      content: "x",
      isBuiltIn: true,
      source: "marketplace",
      status: "disabled",
      category: "development",
      usageCount: 7,
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const skill = await db.skills.get("skill_with_meta")
    // None of those fields should be overwritten by the upgrade hook.
    expect(skill?.source).toBe("marketplace")
    expect(skill?.status).toBe("disabled")
    expect(skill?.category).toBe("development")
    expect(skill?.usageCount).toBe(7)
  })

  it("seed catch handler swallows DatabaseClosedError silently", async () => {
    // Trigger the .catch(...) branch in getDb's seed kickoff. We do this by
    // racing a db.delete() against the inflight seed; Dexie throws
    // DatabaseClosedError which the schema's catch handler short-circuits.
    const db = getDb()
    const seedDeletePromise = db.delete()
    // Wait for the seed promise to settle (the catch should fire).
    await whenSeeded()
    await seedDeletePromise
    // No assertion needed beyond "did not reject" — test passes if we got
    // here without an unhandled rejection.
    expect(true).toBe(true)
  })

  it("seed catch handler logs unrelated errors", async () => {
    // Force the inner seed to reject with a non-DatabaseClosed error so we
    // hit the `console.error` branch. We achieve this by mocking
    // `seedBuiltIns` via jest.doMock with a fresh module load.
    await jest.isolateModulesAsync(async () => {
      jest.doMock("./seed", () => ({
        seedBuiltIns: () => Promise.reject(new Error("boom")),
      }))
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      const fresh = await import("./schema")
      fresh.__resetDbForTesting()
      fresh.getDb()
      await fresh.whenSeeded()
      expect(errSpy).toHaveBeenCalledWith("seedBuiltIns failed", expect.any(Error))
      errSpy.mockRestore()
      fresh.__resetDbForTesting()
    })
  })

  it("v16 upgrade hook migrates customThemes[].colors to tokens.{light,dark}", async () => {
    // Open Dexie at v15 (before the dual-variant rewrite), seed the singleton
    // settings row with a legacy customTheme, close, then re-open through the
    // production schema. The v16 upgrade hook should walk the blob and
    // promote the legacy `{colors, isDark}` pair to `{tokens, baseVariant}`
    // while leaving the legacy fields in place for rollback safety.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })
    await legacy.open()
    await legacy.table("settings").put({
      id: "singleton",
      customThemes: [
        {
          id: "legacy-1",
          name: "Legacy Theme",
          isDark: true,
          colors: {
            background: "#0b0b0b",
            foreground: "#ffffff",
            primary: "#ff00ff",
            primaryForeground: "#000000",
            secondary: "#222222",
            secondaryForeground: "#dddddd",
            accent: "#00ffff",
            accentForeground: "#000000",
            muted: "#1a1a1a",
            mutedForeground: "#aaaaaa",
            card: "#101010",
            cardForeground: "#fafafa",
            popover: "#0d0d0d",
            popoverForeground: "#fafafa",
            input: "#222222",
            border: "#333333",
            ring: "#ff00ff",
            destructive: "#ff4040",
            destructiveForeground: "#ffffff",
            sidebar: "#0a0a0a",
            sidebarForeground: "#fafafa",
            sidebarPrimary: "#ff00ff",
            sidebarBorder: "#222222",
          },
        },
      ],
    })
    legacy.close()

    // Re-open through the production schema — v16 upgrade hook fires.
    const db = getDb()
    await db.open()
    const row = (await db.settings.get("singleton" as never)) as unknown as {
      customThemes?: Array<Record<string, unknown>>
    }
    const t = row?.customThemes?.[0] as Record<string, unknown> | undefined
    expect(t).toBeDefined()
    expect(t?.baseVariant).toBe("dark")
    expect(t?.derivedVariant).toBe("light")
    const tokens = t?.tokens as { light: Record<string, string>; dark: Record<string, string> }
    expect(tokens).toBeDefined()
    // The dark side carries the original palette verbatim.
    expect(tokens.dark.primary).toBe("#ff00ff")
    expect(tokens.dark.background).toBe("#0b0b0b")
    // The light side was synthesized via OKLCH derivation; we don't pin a
    // specific value (Task 6 owns the algorithm), only that something was
    // produced for each of the originally-defined keys.
    expect(typeof tokens.light.primary).toBe("string")
    expect(tokens.light.primary.length).toBeGreaterThan(0)
    expect(typeof tokens.light.background).toBe("string")
    // Legacy fields preserved for one-release rollback safety.
    expect(t?.colors).toBeDefined()
    expect(t?.isDark).toBe(true)
  })

  it("v16 upgrade hook is idempotent — already-migrated rows untouched", async () => {
    // A row that already carries the dual-variant shape must be left alone
    // (no re-derivation, no overwriting hand-edited tokens). We seed with
    // a sentinel `light.primary` value the OKLCH derivation would never
    // produce, then assert it survives intact.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })
    await legacy.open()
    await legacy.table("settings").put({
      id: "singleton",
      customThemes: [
        {
          id: "already-migrated",
          name: "Modern",
          baseVariant: "light",
          derivedVariant: "dark",
          tokens: {
            light: { primary: "#sentinel-light", background: "#fff" },
            dark: { primary: "#sentinel-dark", background: "#000" },
          },
          // No `colors`/`isDark` — already on the new shape.
        },
      ],
    })
    legacy.close()

    const db = getDb()
    await db.open()
    const row = (await db.settings.get("singleton" as never)) as unknown as {
      customThemes?: Array<Record<string, unknown>>
    }
    const t = row?.customThemes?.[0] as Record<string, unknown> | undefined
    const tokens = t?.tokens as { light: Record<string, string>; dark: Record<string, string> }
    // Sentinel values must survive — proves the hook short-circuited.
    expect(tokens.light.primary).toBe("#sentinel-light")
    expect(tokens.dark.primary).toBe("#sentinel-dark")
    expect(t?.baseVariant).toBe("light")
    expect(t?.derivedVariant).toBe("dark")
  })

  it("v16 upgrade hook tolerates a settings row with no customThemes field", async () => {
    // Defensive: the singleton row may exist before any custom theme has
    // been created. The hook must not crash on `customThemes === undefined`.
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(15).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets:
        "id, updatedAt, isBuiltIn, isDefault, isFavorite, sortOrder, category, lastUsedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
      a2uiApps: "id, name, updatedAt, createdAt, isBuiltIn, category, isFavorite, sortOrder",
      a2uiSurfaces: "id, appId, sessionId, updatedAt, createdAt, type",
      a2uiTemplates: "id, name, category, updatedAt, source",
      a2uiEventHistory: "id, surfaceId, [surfaceId+timestamp], timestamp, type",
      twinSources: "&id, twinId, kind, format, status, fingerprint, [twinId+kind], [twinId+status]",
      twinChunks: "&id, twinId, sourceId, vectorDocId, [twinId+sourceId], [twinId+createdAt]",
      twinProfile: "&id, twinId",
      twinDrafts: "&id, twinId, jobId, kind, status, [twinId+status], [twinId+kind]",
      twinJobs: "&id, twinId, status, queuedAt, [twinId+status], [twinId+kind]",
      plugins: "id, name, version, status, source, type, enabled, lastUsedAt, *capabilities",
      pluginPermissions: "[pluginId+permission], pluginId, permission, decision, expiresAt",
      pluginReviews: "[pluginId+id], pluginId, rating, createdAt",
      pluginAnalytics: "[pluginId+key], pluginId, key, lastEventAt",
      pluginScheduledJobs: "id, pluginId, cron, lastRunAt, nextRunAt, status",
    })
    await legacy.open()
    await legacy.table("settings").put({ id: "singleton", colorTheme: "default" })
    legacy.close()

    const db = getDb()
    await expect(db.open()).resolves.toBeDefined()
    const row = (await db.settings.get("singleton" as never)) as unknown as {
      customThemes?: unknown
      colorTheme?: string
    }
    expect(row?.colorTheme).toBe("default")
    // No customThemes field was created; the hook should leave the row alone.
    expect(row?.customThemes).toBeUndefined()
  })

  it("v12 upgrade hook fills preset defaults on legacy rows", async () => {
    const Dexie = (await import("dexie")).default
    const legacy = new Dexie("cognia-claude")
    legacy.version(11).stores({
      sessions: "id, updatedAt, createdAt, kind, characterId, teamId",
      messages: "id, sessionId, [sessionId+createdAt], senderId",
      settings: "id",
      promptPresets: "id, updatedAt",
      mcpServers: "id, name, enabled",
      characters: "id, name, updatedAt, isBuiltIn",
      skills: "id, name, updatedAt, isBuiltIn, category, source, status, lastUsedAt, canonicalId",
      skillResources: "id, skillId, [skillId+kind], [skillId+path], updatedAt",
      teams: "id, name, updatedAt, isBuiltIn",
      sessionState: "sessionId, lastReadAt",
      trustedWorkspaces: "path, trustedAt",
      tts_provider_keys: "id",
      backupHistory: "id, completedAt, type, success",
      canvasDocuments: "id, title, language, type, updatedAt, createdAt",
      canvasVersions: "id, documentId, [documentId+createdAt], isAutoSave",
      canvasComments: "id, documentId, [documentId+createdAt], parentId, resolvedAt",
      canvasSessions: "id, documentId, ownerId, createdAt",
    })
    await legacy.open()
    await legacy.table("promptPresets").put({
      id: "p_legacy",
      name: "Legacy",
      content: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    legacy.close()
    const db = getDb()
    await db.open()
    const p = await db.promptPresets.get("p_legacy")
    expect(p?.isBuiltIn).toBe(false)
    expect(p?.isFavorite).toBe(false)
    expect(p?.usageCount).toBe(0)
    expect(p?.sortOrder).toBe(0)
  })
})
