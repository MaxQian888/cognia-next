/** @jest-environment jsdom */
// End-to-end test for `buildBackupPackage` against a fake IndexedDB. We seed
// each table, build a v3 package, and verify the manifest, payload, checksum,
// and behavior of the include* options.

import "fake-indexeddb/auto"
import { buildBackupPackage, defaultExportFileName, serializePackage } from "./build-package"
import { canonicalStringify } from "./migrate"
import { sha256Hex } from "./crypto"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { saveSettings } from "@/lib/db/settings"
import { PORTABLE_BACKUP_BINDINGS } from "@/lib/data-governance/table-catalog"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  // Touch getDb() so the seed kicks off, then wait it out and wipe everything
  // so each test starts from a known-empty state. Without this we'd race the
  // seed on every test and end up with a mix of seeded built-ins + our rows.
  const db = getDb()
  await whenSeeded()
  await Promise.all([
    db.characters.clear(),
    db.skills.clear(),
    db.teams.clear(),
    db.skillResources.clear(),
  ])
})

it("backs up portable template data without device bindings", async () => {
  const db = getDb()
  await db.templateDefinitions.put({
    storageKey: "draft:skill.backup",
    apiVersion: "cognia.ai/templates/v1",
    id: "skill.backup",
    domain: "skill",
    status: "draft",
    revision: 1,
    version: null,
    metadata: { name: "Backup" },
    payload: { content: "x" },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop"] },
    provenance: { source: "user" },
    contentHash: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
  })
  await db.templateDeviceBindings.put({
    id: "binding",
    definitionId: "skill.backup",
    slotId: "secret",
    kind: "credential",
    localResourceId: "private",
    updatedAt: 1,
  })

  const backup = await buildBackupPackage({
    includeSessions: false,
    includeApiKey: false,
  })

  expect(backup.payload.templateDefinitions).toHaveLength(1)
  expect(backup.payload).not.toHaveProperty("templateDeviceBindings")
})

it("backs up canonical comments for non-canvas resources", async () => {
  await getDb().contextComments.put({
    id: "comment-project-file",
    resourceKind: "project-file",
    resourceId: "README.md",
    projectId: "project-1",
    anchor: { kind: "resource" },
    authorId: "user-1",
    authorName: "User",
    content: "Keep this portable",
    createdAt: 1,
    reactions: [],
  })

  const backup = await buildBackupPackage({ includeSessions: false, includeApiKey: false })

  expect(backup.payload.contextComments).toEqual([
    expect.objectContaining({ id: "comment-project-file", resourceKind: "project-file" }),
  ])
  expect(backup.payload.canvasComments).toEqual([])
})

it("backs up retrieval profiles and ciphertext while excluding rebuildable lexical segments", async () => {
  const db = getDb()
  await db.retrievalProfiles.put({
    id: "memory",
    schemaVersion: 1,
    fingerprint: "fingerprint",
    profile: {
      version: 1,
      id: "memory",
      embedding: { provider: "browser", model: "local", locality: "local" },
      vector: { backend: "native" },
      budgets: { topK: 8, tokenBudget: 2_000, timeoutMs: 500 },
      retrieval: { expansion: false, rerank: false, correctiveFilter: true },
      safety: {
        allowOriginalTextForLocalProvider: false,
        failClosedOnPii: true,
        dataOnlyPromptBoundary: true,
      },
    },
    active: true,
    createdAt: 1,
    updatedAt: 1,
  })
  const envelope = {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyId: "dek-memory",
    iv: "iv",
    ciphertext: "ciphertext",
    aadHash: "aad",
  }
  await db.retrievalEncryptedContent.bulkPut([
    {
      id: "memory:m1:canonical",
      entityType: "memory",
      entityId: "m1",
      corpusId: "memory",
      kind: "canonical",
      envelope,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "segment:g1:0",
      entityType: "bm25_segment",
      entityId: "segment-0",
      corpusId: "memory",
      generationId: "g1",
      kind: "lexical_segment",
      envelope,
      createdAt: 1,
      updatedAt: 1,
    },
  ])

  const backup = await buildBackupPackage({ includeSessions: false, includeApiKey: false })

  expect(backup.payload.retrievalProfiles).toEqual([
    expect.objectContaining({ id: "memory", fingerprint: "fingerprint" }),
  ])
  expect(backup.payload.retrievalEncryptedContent).toEqual([
    expect.objectContaining({ id: "memory:m1:canonical", kind: "canonical" }),
  ])
  expect(backup.payload.retrievalProfileDeks).toBeUndefined()

  const withoutMemories = await buildBackupPackage({
    includeSessions: false,
    includeApiKey: false,
    includeMemories: false,
  })
  expect(withoutMemories.payload.retrievalEncryptedContent).toEqual([])
})

it("emits an adapter field for every catalog-declared portable table", async () => {
  const backup = await buildBackupPackage({
    includeSessions: true,
    includeApiKey: false,
    includeMemories: true,
    includeSettings: true,
    includeCoreData: true,
    includePlugins: true,
  })

  for (const field of new Set(Object.values(PORTABLE_BACKUP_BINDINGS))) {
    expect(backup.payload).toHaveProperty(field)
  }
})

async function seedAll() {
  const db = getDb()
  await saveSettings({
    apiKey: "secret",
    defaultModel: "claude",
    onboardingDismissedAt: "2026-05-18T12:00:00.000Z",
    profile: { displayName: "Max", bio: "hello", avatarDataUrl: "data:image/webp;base64,AA" },
  })
  await db.characters.put({
    id: "c-builtin",
    name: "Built-in",
    avatarColor: "oklch(0 0 0)",
    systemPrompt: "be helpful",
    isBuiltIn: true,
    createdAt: 1,
    updatedAt: 1,
  })
  await db.characters.put({
    id: "c-user",
    name: "Custom",
    avatarColor: "oklch(0 0 0)",
    systemPrompt: "be witty",
    isBuiltIn: false,
    createdAt: 2,
    updatedAt: 2,
  })
  await db.skills.put({
    id: "s-builtin",
    name: "Skill A",
    content: "how-to",
    isBuiltIn: true,
    createdAt: 1,
    updatedAt: 1,
  })
  await db.skills.put({
    id: "s-user",
    name: "Skill B",
    content: "how-to-2",
    isBuiltIn: false,
    createdAt: 2,
    updatedAt: 2,
  })
  await db.skillResources.put({
    id: "r-1",
    skillId: "s-builtin",
    kind: "reference",
    name: "ref1",
    path: "ref/1",
    content: "x",
    createdAt: 1,
    updatedAt: 1,
  })
  await db.skillResources.put({
    id: "r-2",
    skillId: "s-user",
    kind: "reference",
    name: "ref2",
    path: "ref/2",
    content: "y",
    createdAt: 2,
    updatedAt: 2,
  })
  await db.teams.put({
    id: "t-builtin",
    name: "Team A",
    avatarColor: "oklch(0 0 0)",
    members: [],
    orchestration: "round_robin",
    isBuiltIn: true,
    createdAt: 1,
    updatedAt: 1,
  })
  await db.teams.put({
    id: "t-user",
    name: "Team B",
    avatarColor: "oklch(0 0 0)",
    members: [],
    orchestration: "round_robin",
    isBuiltIn: false,
    createdAt: 2,
    updatedAt: 2,
  })
  await db.promptPresets.put({
    id: "p-1",
    name: "preset",
    content: "hi",
    createdAt: 1,
    updatedAt: 1,
  })
  await db.mcpServers.put({
    id: "m-1",
    name: "test",
    transport: "stdio",
    config: { command: "tool", env: { API_KEY: "mcp-secret", COLOR: "blue" } },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  })
  await db.sessions.put({
    id: "sess-1",
    title: "Hi",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  })
  await db.messages.put({
    id: "msg-1",
    sessionId: "sess-1",
    role: "user",
    parts: [{ type: "text", text: "yo" }],
    createdAt: 1,
  })
  await db.sessionState.put({ sessionId: "sess-1", lastReadAt: 1, unreadCount: 0 })
  await db.sessions.put({
    id: "embedded",
    title: "Embedded",
    kind: "resource-workbench",
    visibility: "embedded",
    createdAt: 1,
    updatedAt: 1,
  })
  await db.messages.put({
    id: "embedded-msg",
    sessionId: "embedded",
    role: "user",
    parts: [{ type: "text", text: "private resource context" }],
    createdAt: 1,
  })
  await db.sessionState.put({ sessionId: "embedded", lastReadAt: 1, unreadCount: 0 })
  await db.trustedWorkspaces.put({ path: "/some/dir", trustedAt: 5 })
  await db.tts_provider_keys.put({ id: "tts.providerKey.openai", value: "sk-xxx" })
}

describe("buildBackupPackage", () => {
  it("exports the secret-free Provider Profile Store and strips nested provider keys", async () => {
    const db = getDb()
    await saveSettings({
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-nested",
          apiKeys: ["sk-one", "sk-two"],
          defaultModel: "gpt-5",
          enabled: true,
        },
      },
    })
    await db.providerProfiles.put({
      id: "openai",
      displayName: "OpenAI",
      deploymentRefs: ["openai"],
    })
    await db.deploymentProfiles.put({
      id: "openai",
      providerRef: "openai",
      endpoint: "https://api.openai.com/v1",
      transportProfileRef: "tp-openai",
      credentialProfileRef: { kind: "legacy-provider-settings", providerId: "openai" },
      models: [
        {
          id: "gpt-5",
          upstreamId: "gpt-5",
          canonicalModelRef: "openai:gpt-5",
          offeringRef: "openai:gpt-5",
        },
      ],
    })
    await db.transportProfiles.put({
      id: "tp-openai",
      protocol: "openai",
      auth: { scheme: "bearer" },
    })
    await db.profileStoreMeta.put({
      id: "singleton",
      profileVersion: 7,
      schemaVersion: 2,
    })

    const backup = await buildBackupPackage({
      includeSessions: false,
      includeApiKey: false,
    })

    expect(backup.payload.providerProfileStore).toMatchObject({
      schemaVersion: 2,
      profileVersion: 7,
      providerProfiles: [{ id: "openai" }],
      deploymentProfiles: [{ id: "openai" }],
    })
    expect(backup.payload.providerProfileStore?.transportProfiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tp-openai" })])
    )
    expect(backup.payload.settings?.providerSettings?.openai?.apiKey).toBeUndefined()
    expect(backup.payload.settings?.providerSettings?.openai?.apiKeys).toBeUndefined()
    expect(JSON.stringify(backup.payload.providerProfileStore)).not.toContain("sk-nested")
  })

  it("omits the Provider Profile Store from settings-free exports", async () => {
    const backup = await buildBackupPackage({
      includeSessions: false,
      includeApiKey: false,
      includeSettings: false,
    })

    expect(backup.payload.providerProfileStore).toBeUndefined()
  })

  it("filters built-ins by default and excludes the API key", async () => {
    await seedAll()
    const pkg = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
    expect(pkg.version).toBe("3.0")
    expect(pkg.manifest.version).toBe("3.0")
    expect(pkg.manifest.schemaVersion).toBe(3)
    expect(pkg.manifest.appVersion).toMatch(/\d+\.\d+\.\d+/)
    // Device provenance is stamped in browser-like runtimes (jsdom has
    // window + localStorage) with a generic label, never the raw user agent.
    expect(pkg.manifest.device?.id).toEqual(expect.any(String))
    expect(pkg.manifest.device?.platform).toBe("web")
    expect(pkg.payload.settings?.apiKey).toBeUndefined()
    // onboardingDismissedAt rides on the generic settings blob — never
    // stripped (unlike apiKey) so the user's "I've seen the wizard" flag
    // survives backup/restore.
    expect(pkg.payload.settings?.onboardingDismissedAt).toBe("2026-05-18T12:00:00.000Z")
    // The local user profile rides the settings blob — survives backup/restore
    // with no dedicated payload field.
    expect(pkg.payload.settings?.profile).toEqual({
      displayName: "Max",
      bio: "hello",
      avatarDataUrl: "data:image/webp;base64,AA",
    })
    expect(pkg.payload.characters?.map((c) => c.id)).toEqual(["c-user"])
    expect(pkg.payload.skills?.map((s) => s.id)).toEqual(["s-user"])
    expect(pkg.payload.teams?.map((t) => t.id)).toEqual(["t-user"])
    // Built-in skill's resources are dropped along with the skill.
    expect(pkg.payload.skillResources?.map((r) => r.id).sort()).toEqual(["r-2"])
    expect(pkg.payload.sessions?.map((s) => s.id)).toEqual(["sess-1"])
    expect(pkg.payload.messages?.map((m) => m.id)).toEqual(["msg-1"])
    expect(pkg.payload.sessionState?.map((s) => s.sessionId)).toEqual(["sess-1"])
    expect(pkg.payload.trustedWorkspaces?.map((w) => w.path)).toEqual(["/some/dir"])
    expect(pkg.payload.mcpServers?.[0].config).toEqual({
      command: "tool",
      env: { API_KEY: { secretRef: "mcp/m-1/env/API_KEY" }, COLOR: "blue" },
    })
    expect(pkg.payload.mcpCredentialManifest).toEqual([
      { serverId: "m-1", references: ["mcp/m-1/env/API_KEY"] },
    ])
    expect(JSON.stringify(pkg.payload)).not.toContain("mcp-secret")
    // Secret-bearing tables never leave the credential seam. Legacy packages
    // carrying this optional field remain importable, but new exports omit it.
    expect(pkg.payload.ttsProviderKeys).toBeUndefined()
  })

  it("includes built-ins and the API key when explicitly opted in", async () => {
    await seedAll()
    const pkg = await buildBackupPackage({
      includeSessions: false,
      includeApiKey: true,
      includeBuiltIns: true,
    })
    expect(pkg.payload.settings?.apiKey).toBe("secret")
    expect(pkg.payload.characters?.length).toBe(2)
    expect(pkg.payload.skills?.length).toBe(2)
    expect(pkg.payload.teams?.length).toBe(2)
    // Sessions/messages/sessionState are omitted when includeSessions=false.
    expect(pkg.payload.sessions).toBeUndefined()
    expect(pkg.payload.messages).toBeUndefined()
    expect(pkg.payload.sessionState).toBeUndefined()
  })

  it("computes a manifest checksum that matches sha256(canonical(payload))", async () => {
    await seedAll()
    const pkg = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
    const expected = await sha256Hex(canonicalStringify(pkg.payload))
    expect(pkg.manifest.integrity.checksum).toBe(expected)
    expect(pkg.manifest.integrity.algorithm).toBe("SHA-256")
  })

  it("exports the complete non-builtin plugin domain", async () => {
    const db = getDb()
    await db.plugins.bulkPut([
      {
        id: "plugin-user",
        name: "User plugin",
        version: "1.0.0",
        status: "loaded",
        source: "local",
        type: "frontend",
        enabled: true,
        capabilities: ["tools"],
        path: "/plugins/user",
        manifest: { id: "plugin-user" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "plugin-builtin",
        name: "Built-in plugin",
        version: "1.0.0",
        status: "loaded",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: [],
        path: "<builtin>/plugin",
        manifest: { id: "plugin-builtin" },
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    await db.pluginPermissions.put({
      pluginId: "plugin-user",
      permission: "clipboard:read",
      decision: "allow",
      grantedAt: 1,
    })
    await db.pluginReviews.put({
      pluginId: "plugin-user",
      id: "review-1",
      rating: 5,
      createdAt: 1,
    })
    await db.pluginAnalytics.put({
      pluginId: "plugin-user",
      key: "tool.invoke",
      count: 2,
      lastEventAt: 1,
    })

    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage: null }
    )

    expect(pkg.payload.plugins).toEqual([expect.objectContaining({ id: "plugin-user" })])
    expect(pkg.payload.pluginPermissions).toHaveLength(1)
    expect(pkg.payload.pluginReviews).toHaveLength(1)
    expect(pkg.payload.pluginAnalytics).toHaveLength(1)
  })

  it("honors exact domain selection for settings-only and sessions-only backups", async () => {
    await seedAll()
    const settingsOnly = await buildBackupPackage(
      {
        includeSessions: false,
        includeApiKey: false,
        includeSettings: true,
        includeCoreData: false,
        includePlugins: false,
        includeLocalStorage: false,
      },
      { storage: null }
    )
    expect(Object.keys(settingsOnly.payload).sort()).toEqual(["providerProfileStore", "settings"])

    const sessionsOnly = await buildBackupPackage(
      {
        includeSessions: true,
        includeApiKey: false,
        includeSettings: false,
        includeCoreData: false,
        includePlugins: false,
        includeLocalStorage: false,
      },
      { storage: null }
    )
    expect(Object.keys(sessionsOnly.payload).sort()).toEqual([
      "messages",
      "sessionState",
      "sessions",
    ])
  })
})

describe("serializePackage", () => {
  it("produces pretty-printed JSON parseable back to the same object", async () => {
    await seedAll()
    const pkg = await buildBackupPackage({ includeSessions: false, includeApiKey: false })
    const serialized = serializePackage(pkg)
    expect(serialized).toContain("\n  ")
    expect(JSON.parse(serialized)).toEqual(pkg)
  })
})

describe("defaultExportFileName", () => {
  it("uses .cbk for plaintext and .enc.cbk for encrypted", () => {
    const d = new Date("2024-03-04T10:00:00Z")
    expect(defaultExportFileName(d, "plain")).toMatch(/^cognia-backup-\d{4}-\d{2}-\d{2}\.cbk$/)
    expect(defaultExportFileName(d, "encrypted")).toMatch(
      /^cognia-backup-\d{4}-\d{2}-\d{2}\.enc\.cbk$/
    )
  })
})

describe("buildBackupPackage — localStorage snapshots", () => {
  it("captures every persist key present in storage", async () => {
    const storage = {
      _data: new Map<string, string>([
        ["cognia-external-agents", JSON.stringify({ state: { agents: { foo: 1 } }, version: 5 })],
        ["cognia-custom-modes", JSON.stringify({ state: { customModes: {} }, version: 0 })],
      ]),
      getItem(k: string) {
        return this._data.get(k) ?? null
      },
      setItem(k: string, v: string) {
        this._data.set(k, v)
      },
      removeItem(k: string) {
        this._data.delete(k)
      },
    }
    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage }
    )
    expect(pkg.payload.localStorageSnapshots).toBeDefined()
    expect(pkg.payload.localStorageSnapshots?.["cognia-external-agents"]?.raw.state).toEqual({
      agents: { foo: 1 },
    })
    expect(pkg.payload.localStorageSnapshots?.["cognia-custom-modes"]).toBeDefined()
  })

  it("omits the field entirely when storage is empty", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage }
    )
    expect(pkg.payload.localStorageSnapshots).toBeUndefined()
  })

  it("omits the field entirely when storage=null is forced (non-browser caller)", async () => {
    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage: null }
    )
    expect(pkg.payload.localStorageSnapshots).toBeUndefined()
  })
})

describe("buildBackupPackage — twin tables", () => {
  it("captures every twin table in the payload", async () => {
    const db = getDb()
    await db.twinSources.put({
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
    })
    await db.twinChunks.put({
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
    })
    await db.twinProfile.put({
      id: "twin_alice",
      twinId: "twin_alice",
      styleSamples: [],
      playbooks: [],
      entities: [],
      decisions: [],
      voiceSummary: "",
      updatedAt: 3,
    })
    await db.twinDrafts.put({
      id: "tdr_1",
      twinId: "twin_alice",
      jobId: "twj_1",
      kind: "skill",
      payload: { kind: "skill", data: { name: "Demo" } },
      provenance: { chunkIds: ["tchk_1"], rationale: "test" },
      status: "pending",
      createdAt: 4,
    })
    await db.twinJobs.put({
      id: "twj_1",
      twinId: "twin_alice",
      kind: "ingest",
      sourceIds: ["tsrc_1"],
      status: "completed",
      phase: "completed",
      progress: 100,
      queuedAt: 5,
      retryCount: 0,
    })

    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage: null }
    )

    expect(pkg.payload.twinSources).toHaveLength(1)
    expect(pkg.payload.twinSources?.[0].id).toBe("tsrc_1")
    expect(pkg.payload.twinChunks).toHaveLength(1)
    expect(pkg.payload.twinChunks?.[0].vectorDocId).toBe("vec_1")
    expect(pkg.payload.twinProfile).toHaveLength(1)
    expect(pkg.payload.twinProfile?.[0].twinId).toBe("twin_alice")
    expect(pkg.payload.twinDrafts).toHaveLength(1)
    expect(pkg.payload.twinJobs).toHaveLength(1)
  })

  it("emits empty arrays when no twin data exists (legacy users)", async () => {
    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage: null }
    )
    expect(pkg.payload.twinSources).toEqual([])
    expect(pkg.payload.twinChunks).toEqual([])
    expect(pkg.payload.twinProfile).toEqual([])
    expect(pkg.payload.twinDrafts).toEqual([])
    expect(pkg.payload.twinJobs).toEqual([])
  })
})

describe("buildBackupPackage — learned memory", () => {
  it("exports canonical memories with their evidence, jobs, and audit trail", async () => {
    const db = getDb()
    await db.memories.put({
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
    })
    await db.memoryEvidence.put({
      id: "mev_1",
      memoryId: "mem_1",
      kind: "message",
      sourceId: "source_1",
      contaminationState: "clean",
      reviewed: true,
      createdAt: 1,
    })
    await db.memoryJobs.put({
      id: "mjob_1",
      dedupeKey: "turn:s1:m1",
      kind: "turn-extraction",
      status: "succeeded",
      scope: "workspace",
      projectId: "project_1",
      provenance: "user",
      evidenceIds: ["mev_1"],
      queuedAt: 1,
      completedAt: 2,
      retryCount: 0,
    })
    await db.memoryAuditEvents.put({
      id: "maudit_1",
      action: "created",
      memoryId: "mem_1",
      reason: "turn-extraction",
      createdAt: 2,
    })

    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false },
      { storage: null }
    )

    expect(pkg.payload.memories?.map((row) => row.id)).toEqual(["mem_1"])
    expect(pkg.payload.memoryEvidence?.[0].memoryId).toBe("mem_1")
    expect(pkg.payload.memoryJobs?.[0].evidenceIds).toEqual(["mev_1"])
    expect(pkg.payload.memoryAuditEvents?.[0].memoryId).toBe("mem_1")
  })

  it("can omit the learned-memory graph for callers without memory read authority", async () => {
    const db = getDb()
    await db.memories.put({
      id: "mem_private",
      scope: "global",
      type: "semantic",
      text: "Private preference",
      tags: [],
      importance: 5,
      createdAt: 1,
      updatedAt: 1,
      lastAccessedAt: 1,
      accessCount: 0,
      version: 1,
      status: "active",
      pinned: false,
      provenance: "user",
    })
    const pkg = await buildBackupPackage(
      { includeSessions: false, includeApiKey: false, includeMemories: false },
      { storage: null }
    )
    expect(pkg.payload.memories).toBeUndefined()
    expect(pkg.payload.memoryEvidence).toBeUndefined()
    expect(pkg.payload.memoryJobs).toBeUndefined()
    expect(pkg.payload.memoryAuditEvents).toBeUndefined()
  })
})
