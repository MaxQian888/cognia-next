// Coverage for the per-domain export/import surface. We seed each domain's
// table, build an export, then apply it back into a fresh DB and confirm the
// rows are restored.

import "fake-indexeddb/auto"
import {
  applyDomainImport,
  buildDomainExport,
  defaultDomainFileName,
  detectDomainFile,
  getDomain,
  serializeDomainFile,
  DOMAIN_TRANSFERS,
} from "./index"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
  // Wipe seeded built-ins so we test on our own fixtures.
  const db = getDb()
  await Promise.all([
    db.skills.clear(),
    db.skillResources.clear(),
    db.characters.clear(),
    db.teams.clear(),
  ])
})

describe("DOMAIN_TRANSFERS", () => {
  it("exposes a spec for every advertised domain", () => {
    const keys = DOMAIN_TRANSFERS.map((d) => d.key).sort()
    expect(keys).toEqual(
      [
        // Dexie-backed domains
        "a2ui",
        "canvas",
        "characters",
        "mcpServers",
        "promptPresets",
        "settingsTheme",
        "skills",
        "teams",
        // Zustand-persist (localStorage) snapshot-backed domains
        "a2uiSurfaces",
        "agentRuntime",
        "agentTeamsLayout",
        "artifacts",
        "canvasComments",
        "canvasKeybindings",
        "canvasSettings",
        "customModes",
        "customThemes",
        "externalAgents",
        "schedulerPrefs",
      ].sort()
    )
  })

  it("getDomain returns undefined for unknown keys", () => {
    expect(getDomain("does-not-exist" as never)).toBeUndefined()
  })
})

describe("DOMAIN_TRANSFERS — snapshot-backed domains", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear()
  })

  it("externalAgents export wraps the persist payload as localStorageSnapshots", async () => {
    localStorage.setItem(
      "cognia-external-agents",
      JSON.stringify({ state: { agents: { foo: 1 } }, version: 5 })
    )
    const file = await buildDomainExport("externalAgents")
    const snap = file.payload.localStorageSnapshots?.["cognia-external-agents"]
    expect(snap?.raw.state).toEqual({ agents: { foo: 1 } })
  })

  it("snapshot domain returns empty payload when storage is empty", async () => {
    const file = await buildDomainExport("customThemes")
    expect(file.payload.localStorageSnapshots).toBeUndefined()
  })
})

describe("buildDomainExport — skills", () => {
  it("includes user skills + their resources but skips built-ins", async () => {
    const db = getDb()
    await db.skills.put({
      id: "s-built",
      name: "B",
      content: "x",
      isBuiltIn: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.skills.put({
      id: "s-user",
      name: "U",
      content: "y",
      isBuiltIn: false,
      createdAt: 2,
      updatedAt: 2,
    })
    await db.skillResources.put({
      id: "r-1",
      skillId: "s-user",
      kind: "reference",
      name: "ref",
      path: "ref/1",
      content: "z",
      createdAt: 1,
      updatedAt: 1,
    })
    await db.skillResources.put({
      id: "r-builtin",
      skillId: "s-built",
      kind: "reference",
      name: "ref2",
      path: "ref/2",
      content: "z",
      createdAt: 1,
      updatedAt: 1,
    })

    const file = await buildDomainExport("skills")
    expect(file.payload.skills?.map((s) => s.id)).toEqual(["s-user"])
    expect(file.payload.skillResources?.map((r) => r.id)).toEqual(["r-1"])
  })
})

describe("detectDomainFile", () => {
  it("matches the version + domain + payload triple", async () => {
    const file = await buildDomainExport("promptPresets")
    expect(detectDomainFile(file)).toBe(true)
    expect(detectDomainFile({})).toBe(false)
    expect(detectDomainFile({ version: "wrong", domain: "x", payload: {} })).toBe(false)
  })
})

describe("buildDomainExport — promptPresets", () => {
  it("excludes built-in presets from the export payload", async () => {
    const db = getDb()
    await db.promptPresets.put({
      id: "preset_builtin_test",
      name: "Built-in",
      content: "x",
      isBuiltIn: true,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.promptPresets.put({
      id: "p_user",
      name: "Mine",
      content: "y",
      isBuiltIn: false,
      createdAt: 2,
      updatedAt: 2,
    })
    const file = await buildDomainExport("promptPresets")
    expect(file.payload.promptPresets?.map((p) => p.id)).toEqual(["p_user"])
  })

  it("preserves every extended preset field across a round-trip", async () => {
    const db = getDb()
    await db.promptPresets.put({
      id: "p_rich",
      name: "Rich",
      content: "you are…",
      description: "desc",
      icon: "⭐",
      color: "oklch(0.7 0.15 250)",
      category: "coding",
      model: "claude-x",
      permissionMode: "plan",
      effort: "high",
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["WebSearch"],
      mcpServerIds: ["m1"],
      skillIds: ["s1"],
      agentModeId: "code-gen",
      workingDir: "/proj",
      isFavorite: true,
      sortOrder: 3,
      usageCount: 7,
      lastUsedAt: 100,
      createdAt: 1,
      updatedAt: 2,
    })
    const file = await buildDomainExport("promptPresets")
    await db.promptPresets.clear()
    await applyDomainImport(file, "skip")
    const fetched = await db.promptPresets.get("p_rich")
    expect(fetched).toMatchObject({
      id: "p_rich",
      name: "Rich",
      description: "desc",
      icon: "⭐",
      color: "oklch(0.7 0.15 250)",
      category: "coding",
      model: "claude-x",
      permissionMode: "plan",
      effort: "high",
      allowedTools: ["Bash", "Read"],
      disallowedTools: ["WebSearch"],
      mcpServerIds: ["m1"],
      skillIds: ["s1"],
      agentModeId: "code-gen",
      workingDir: "/proj",
      isFavorite: true,
      sortOrder: 3,
    })
  })
})

describe("applyDomainImport — round-trip", () => {
  it("restores prompt presets after a full wipe", async () => {
    const db = getDb()
    await db.promptPresets.put({
      id: "p1",
      name: "preset",
      content: "hi",
      createdAt: 1,
      updatedAt: 1,
    })
    const file = await buildDomainExport("promptPresets")
    await db.promptPresets.clear()

    await applyDomainImport(file, "skip")
    const rows = await db.promptPresets.toArray()
    expect(rows.map((r) => r.id)).toEqual(["p1"])
  })

  it("respects the merge strategy on collision", async () => {
    const db = getDb()
    await db.promptPresets.put({
      id: "p1",
      name: "local",
      content: "L",
      createdAt: 1,
      updatedAt: 1,
    })
    const file = await buildDomainExport("promptPresets")
    // Mutate the in-memory file to differ from local
    file.payload.promptPresets![0].name = "remote"

    const skip = await applyDomainImport(file, "skip")
    expect(skip.skipped.promptPresets).toBe(1)
    expect((await db.promptPresets.get("p1"))?.name).toBe("local")

    const over = await applyDomainImport(file, "overwrite")
    expect(over.overwritten.promptPresets).toBe(1)
    expect((await db.promptPresets.get("p1"))?.name).toBe("remote")
  })
})

describe("settingsTheme — projection", () => {
  it("only carries the appearance fields, never the API key", async () => {
    const db = getDb()
    await db.settings.put({
      id: "singleton",
      alwaysAllowTools: ["Read"],
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
      },
      apiKey: "sk-secret",
      theme: "dark",
      fontScale: "lg",
      language: "en",
      reduceMotion: true,
    })
    const file = await buildDomainExport("settingsTheme")
    expect(file.payload.settings?.theme).toBe("dark")
    expect(file.payload.settings?.fontScale).toBe("lg")
    expect(file.payload.settings?.apiKey).toBeUndefined()
  })
})

describe("filename helpers", () => {
  it("defaultDomainFileName produces a date-stamped json filename", () => {
    expect(defaultDomainFileName("skills", new Date("2024-04-15T00:00:00Z"))).toMatch(
      /^cognia-skills-\d{4}-\d{2}-\d{2}\.json$/
    )
  })

  it("serializeDomainFile produces parseable pretty-printed JSON", async () => {
    const file = await buildDomainExport("mcpServers")
    const json = serializeDomainFile(file)
    expect(json).toContain("\n  ")
    expect(JSON.parse(json)).toEqual(file)
  })
})
