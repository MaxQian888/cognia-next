import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { CogpackInstallRow, CogsetRow, CogsetStateRow } from "@/types/plugin/plugin-cogset"

import { applyCogsetBackup, portableCogset, portableCogsetState } from "./apply-cogsets"
import type { ImportSummary } from "./types"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function summary(): ImportSummary {
  return { added: {}, overwritten: {}, skipped: {}, builtInsSkipped: {} }
}

let counter = 0
const newId = (prefix: string) => `${prefix}_new_${++counter}`

const cogset = (overrides: Partial<CogsetRow> = {}): CogsetRow => ({
  id: "cs1",
  name: "Writing",
  members: [{ pluginId: "pdf" }, { pluginId: "cognia-office" }],
  source: { kind: "manual" },
  lastApplied: { status: "applied", at: 1, outcomes: [] },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const install = (overrides: Partial<CogpackInstallRow> = {}): CogpackInstallRow => ({
  id: "ci1",
  cogpackId: "writer",
  version: "1.0.0",
  name: "Writer",
  fingerprint: "f",
  trust: "unsigned",
  manifest: {
    schemaVersion: 1,
    kind: "cognia.cogpack",
    id: "writer",
    version: "1.0.0",
    name: "Writer",
    compatibility: { minHostVersion: "0.1.0" },
    members: [],
  },
  cogsetId: "cs1",
  missing: [],
  installedAt: 1,
  ...overrides,
})

describe("portable projections", () => {
  it("drops this host's activation result and runtime facts", () => {
    expect(portableCogset(cogset())).not.toHaveProperty("lastApplied")
    const state: CogsetStateRow = {
      id: "host",
      alwaysOn: ["a"],
      globalCogsetId: "cs1",
      appliedCogsetId: "cs1",
      appliedAt: 5,
      pending: { cogsetId: "cs1", reason: "runs-in-flight", since: 1 },
      defaultBootstrappedAt: 2,
      updatedAt: 9,
    }
    expect(portableCogsetState(state)).toEqual([
      {
        id: "host",
        alwaysOn: ["a"],
        globalCogsetId: "cs1",
        defaultBootstrappedAt: 2,
        updatedAt: 9,
      },
    ])
    expect(portableCogsetState(undefined)).toEqual([])
  })
})

describe("applyCogsetBackup", () => {
  it("adds cogsets with remapped plugin ids and without the exporter's lastApplied", async () => {
    const s = summary()
    await applyCogsetBackup({
      db: getDb(),
      cogsets: [portableCogset(cogset())],
      cogpackInstalls: [install()],
      cogsetState: [
        { id: "host", alwaysOn: ["pdf", "cognia-web-tools"], globalCogsetId: "cs1", updatedAt: 1 },
      ],
      pluginIdMap: new Map([["pdf", "plugin_copy"]]),
      opts: { mergeStrategy: "skip" },
      summary: s,
      newId,
    })
    const stored = await getDb().pluginCogsets.get("cs1")
    expect(stored?.members.map((m) => m.pluginId)).toEqual(["plugin_copy", "cognia-office"])
    expect(stored?.lastApplied).toBeUndefined()
    expect(await getDb().cogpackInstalls.get("ci1")).toBeDefined()
    const state = await getDb().pluginCogsetState.get("host")
    expect(state?.alwaysOn).toEqual(["cognia-web-tools", "plugin_copy"])
    expect(state?.globalCogsetId).toBe("cs1")
    expect(s.added).toMatchObject({ pluginCogsets: 1, cogpackInstalls: 1, pluginCogsetState: 1 })
  })

  it("keeps local runtime facts and drops a global choice whose cogset did not arrive", async () => {
    await getDb().pluginCogsetState.put({
      id: "host",
      alwaysOn: ["local"],
      appliedCogsetId: "mine",
      appliedAt: 7,
      updatedAt: 1,
    })
    await applyCogsetBackup({
      db: getDb(),
      cogsets: [],
      cogpackInstalls: [],
      cogsetState: [{ id: "host", alwaysOn: ["x"], globalCogsetId: "gone", updatedAt: 2 }],
      pluginIdMap: new Map(),
      opts: { mergeStrategy: "overwrite" },
      summary: summary(),
      newId,
    })
    const state = await getDb().pluginCogsetState.get("host")
    expect(state).toMatchObject({ alwaysOn: ["x"], appliedCogsetId: "mine", appliedAt: 7 })
    expect(state?.globalCogsetId).toBeUndefined()
  })

  it("skip leaves existing rows and state alone", async () => {
    await getDb().pluginCogsets.put(cogset({ name: "Local" }))
    await getDb().pluginCogsetState.put({ id: "host", alwaysOn: ["local"], updatedAt: 1 })
    const s = summary()
    await applyCogsetBackup({
      db: getDb(),
      cogsets: [cogset({ name: "Incoming" })],
      cogpackInstalls: [],
      cogsetState: [{ id: "host", alwaysOn: ["x"], updatedAt: 2 }],
      pluginIdMap: new Map(),
      opts: { mergeStrategy: "skip" },
      summary: s,
      newId,
    })
    expect((await getDb().pluginCogsets.get("cs1"))?.name).toBe("Local")
    expect((await getDb().pluginCogsetState.get("host"))?.alwaysOn).toEqual(["local"])
    expect(s.skipped).toMatchObject({ pluginCogsets: 1, pluginCogsetState: 1 })
  })

  it("overwrite keeps this host's lastApplied", async () => {
    const local = cogset({ lastApplied: { status: "partial", at: 3, outcomes: [] } })
    await getDb().pluginCogsets.put(local)
    await applyCogsetBackup({
      db: getDb(),
      cogsets: [portableCogset(cogset({ name: "Incoming" }))],
      cogpackInstalls: [],
      cogsetState: [],
      pluginIdMap: new Map(),
      opts: { mergeStrategy: "overwrite" },
      summary: summary(),
      newId,
    })
    const stored = await getDb().pluginCogsets.get("cs1")
    expect(stored?.name).toBe("Incoming")
    expect(stored?.lastApplied).toEqual(local.lastApplied)
  })

  it("duplicate mints new ids and keeps an imported cogpack pointing at its copied cogset", async () => {
    await getDb().pluginCogsets.put(
      cogset({
        source: {
          kind: "cogpack",
          cogpackId: "writer",
          version: "1.0.0",
          fingerprint: "f",
          installId: "ci1",
        },
      })
    )
    await getDb().cogpackInstalls.put(install())
    await applyCogsetBackup({
      db: getDb(),
      cogsets: [
        portableCogset(
          cogset({
            source: {
              kind: "cogpack",
              cogpackId: "writer",
              version: "1.0.0",
              fingerprint: "f",
              installId: "ci1",
            },
          })
        ),
      ],
      cogpackInstalls: [install()],
      cogsetState: [{ id: "host", alwaysOn: [], globalCogsetId: "cs1", updatedAt: 2 }],
      pluginIdMap: new Map(),
      opts: { mergeStrategy: "duplicate" },
      summary: summary(),
      newId,
    })
    const cogsets = await getDb().pluginCogsets.toArray()
    expect(cogsets).toHaveLength(2)
    const copy = cogsets.find((row) => row.id !== "cs1")!
    const installs = await getDb().cogpackInstalls.toArray()
    const copiedInstall = installs.find((row) => row.id !== "ci1")!
    expect(copiedInstall.cogsetId).toBe(copy.id)
    expect(copy.source).toMatchObject({ kind: "cogpack", installId: copiedInstall.id })
    expect((await getDb().pluginCogsetState.get("host"))?.globalCogsetId).toBe(copy.id)
  })
})
