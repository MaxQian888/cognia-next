/** @jest-environment jsdom */
import { createCharacterPackAdapter, type CharacterPackRow } from "./character-pack-adapter"

function row(overrides: Partial<CharacterPackRow> = {}): CharacterPackRow {
  return {
    characterId: "c1",
    displayName: "Ada",
    pluginId: "acme.pack",
    appliedVersion: "1.0.0",
    availableVersion: "1.1.0",
    ...overrides,
  }
}

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: null,
}

describe("check", () => {
  it("offers a pack whose parent plugin moved ahead", async () => {
    const adapter = createCharacterPackAdapter({ listPacks: async () => [row()] })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate).toMatchObject({
      assetId: "c1",
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      executor: "character-pack-runtime",
      source: "plugin-host",
    })
  })

  it("never treats a locally authored pack as a remote update", async () => {
    const adapter = createCharacterPackAdapter({
      listPacks: async () => [row({ local: true })],
    })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("stays quiet when the applied version already matches", async () => {
    const adapter = createCharacterPackAdapter({
      listPacks: async () => [row({ availableVersion: "1.0.0" })],
    })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("flags a pack with user edits so the diff is shown first", async () => {
    const adapter = createCharacterPackAdapter({
      listPacks: async () => [row({ userEditedFields: 3 })],
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.permissionsExpanded).toBe(true)
  })

  it("does not flag a pack the user never touched", async () => {
    const adapter = createCharacterPackAdapter({
      listPacks: async () => [row({ userEditedFields: 0 })],
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.permissionsExpanded).toBe(false)
  })
})

describe("apply", () => {
  it("opens the existing three-way diff and leaves the outcome to it", async () => {
    const opened: string[] = []
    const adapter = createCharacterPackAdapter({
      listPacks: async () => [row()],
      openDiff: async (id) => {
        opened.push(id)
      },
    })
    const [candidate] = await adapter.check(CONTEXT)
    const result = await adapter.apply(candidate, { consented: true })
    expect(opened).toEqual(["c1"])
    expect(result.state).toBe("available")
  })

  it("reports the missing dialog rather than claiming an update", async () => {
    const adapter = createCharacterPackAdapter({ listPacks: async () => [row()] })
    const [candidate] = await adapter.check(CONTEXT)
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("failed")
  })
})
