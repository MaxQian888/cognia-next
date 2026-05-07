// End-to-end test for `buildBackupPackage` against a fake IndexedDB. We seed
// each table, build a v3 package, and verify the manifest, payload, checksum,
// and behavior of the include* options.

import "fake-indexeddb/auto"
import { buildBackupPackage, defaultExportFileName, serializePackage } from "./build-package"
import { canonicalStringify } from "./migrate"
import { sha256Hex } from "./crypto"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import { saveSettings } from "@/lib/db/settings"

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

async function seedAll() {
  const db = getDb()
  await saveSettings({ apiKey: "secret", defaultModel: "claude" })
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
    config: {},
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
  await db.trustedWorkspaces.put({ path: "/some/dir", trustedAt: 5 })
  await db.tts_provider_keys.put({ id: "tts.providerKey.openai", value: "sk-xxx" })
}

describe("buildBackupPackage", () => {
  it("filters built-ins by default and excludes the API key", async () => {
    await seedAll()
    const pkg = await buildBackupPackage({ includeSessions: true, includeApiKey: false })
    expect(pkg.version).toBe("3.0")
    expect(pkg.manifest.version).toBe("3.0")
    expect(pkg.manifest.schemaVersion).toBe(3)
    expect(pkg.manifest.appVersion).toMatch(/\d+\.\d+\.\d+/)
    expect(pkg.payload.settings?.apiKey).toBeUndefined()
    expect(pkg.payload.characters?.map((c) => c.id)).toEqual(["c-user"])
    expect(pkg.payload.skills?.map((s) => s.id)).toEqual(["s-user"])
    expect(pkg.payload.teams?.map((t) => t.id)).toEqual(["t-user"])
    // Built-in skill's resources are dropped along with the skill.
    expect(pkg.payload.skillResources?.map((r) => r.id).sort()).toEqual(["r-2"])
    expect(pkg.payload.sessions?.map((s) => s.id)).toEqual(["sess-1"])
    expect(pkg.payload.messages?.map((m) => m.id)).toEqual(["msg-1"])
    expect(pkg.payload.sessionState?.map((s) => s.sessionId)).toEqual(["sess-1"])
    expect(pkg.payload.trustedWorkspaces?.map((w) => w.path)).toEqual(["/some/dir"])
    expect(pkg.payload.ttsProviderKeys?.map((k) => k.id)).toEqual(["tts.providerKey.openai"])
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
