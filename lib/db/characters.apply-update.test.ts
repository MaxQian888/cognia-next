/**
 * Apply Update + clone-hides-overlay dedupe tests (ADR-0030 v49).
 *
 * Exercises the new Dexie-side helpers in `lib/db/characters.ts`:
 *   - duplicateCharacter captures `pristineSnapshot` when source is overlay
 *   - listCharacters hides overlay rows whose synthetic id is referenced
 *     by an existing Dexie clone's `clonedFromPackCharacterId`
 *   - applyPackUpdate diffs row vs overlay and writes back only un-edited fields
 *   - applyPackUpdateForPack batches over every clone of a given pack
 */

import {
  applyPackUpdate,
  applyPackUpdateForPack,
  duplicateCharacter,
  listCharacters,
  previewPackUpdate,
} from "./characters"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  __resetCharacterPacksForTesting,
  buildOverlayCharacterId,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"

const PLUGIN_ID = "demo-plugin"
const PACK_ID = "workplace"

function makeChar(localId: string, over: Partial<PluginCharacterDef> = {}): PluginCharacterDef {
  return {
    localId,
    name: `Char ${localId}`,
    avatarColor: "oklch(0.7 0.15 250)",
    systemPrompt: `v1 prompt for ${localId}`,
    description: "v1 description",
    model: "claude-opus-4-7",
    allowedTools: ["Read"],
    ...over,
  }
}

function makePack(
  characters: PluginCharacterDef[],
  over: Partial<PluginCharacterPackDef> = {}
): PluginCharacterPackDef {
  return {
    id: PACK_ID,
    name: "Workplace",
    version: "1.0.0",
    characters,
    ...over,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().characters.clear()
  __resetCharacterPacksForTesting()
})
afterAll(dbFixture.dispose)

describe("duplicateCharacter on overlay source", () => {
  it("captures pristineSnapshot of overlay's pack-managed fields", async () => {
    const overlayChar = makeChar("alice")
    registerCharacterPack(PACK_ID, makePack([overlayChar]), { pluginId: PLUGIN_ID })
    const overlayId = buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice")
    const copy = await duplicateCharacter(overlayId)
    expect(copy.sourcePluginId).toBe(PLUGIN_ID)
    expect(copy.sourcePackId).toBe(PACK_ID)
    expect(copy.clonedFromPackCharacterId).toBe(overlayId)
    expect(copy.packVersionAtClone).toBe("1.0.0")
    expect(copy.pristineSnapshot).toBeDefined()
    expect(copy.pristineSnapshot?.systemPrompt).toBe("v1 prompt for alice")
    expect(copy.pristineSnapshot?.description).toBe("v1 description")
    expect(copy.pristineSnapshot?.allowedTools).toEqual(["Read"])
  })

  it("inherits the source row's snapshot when source is itself a Dexie clone", async () => {
    const overlayChar = makeChar("alice")
    registerCharacterPack(PACK_ID, makePack([overlayChar]), { pluginId: PLUGIN_ID })
    const first = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    const second = await duplicateCharacter(first.id)
    expect(second.pristineSnapshot).toEqual(first.pristineSnapshot)
  })
})

describe("listCharacters clone-hides-overlay dedupe", () => {
  it("hides overlay rows that already have a Dexie clone", async () => {
    const overlayChar = makeChar("alice")
    registerCharacterPack(PACK_ID, makePack([overlayChar]), { pluginId: PLUGIN_ID })
    // Before cloning, the overlay row is visible.
    const before = await listCharacters()
    expect(before.some((c) => c.id.startsWith("cognia-pack:"))).toBe(true)
    // After cloning, the overlay row is hidden by the Dexie row that
    // points at it via `clonedFromPackCharacterId`.
    await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    const after = await listCharacters()
    expect(after.some((c) => c.id.startsWith("cognia-pack:"))).toBe(false)
    expect(after).toHaveLength(1)
    expect(after[0].sourcePluginId).toBe(PLUGIN_ID)
  })

  it("keeps showing other overlay characters in the same pack", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice"), makeChar("bob")]), {
      pluginId: PLUGIN_ID,
    })
    await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    const all = await listCharacters()
    // The Dexie clone of Alice + the still-overlay Bob.
    expect(all).toHaveLength(2)
    const overlayIds = all.filter((c) => c.id.startsWith("cognia-pack:")).map((c) => c.id)
    expect(overlayIds).toEqual([buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "bob")])
  })
})

describe("applyPackUpdate", () => {
  it("overwrites un-edited fields and snaps packVersion forward", async () => {
    const overlayChar = makeChar("alice")
    registerCharacterPack(PACK_ID, makePack([overlayChar]), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))

    // Simulate a new pack release.
    const newOverlay = makeChar("alice", {
      systemPrompt: "v2 prompt for alice",
      description: "v2 description",
      allowedTools: ["Read", "Bash"],
    })
    registerCharacterPack(PACK_ID, makePack([newOverlay], { version: "2.0.0" }), {
      pluginId: PLUGIN_ID,
    })

    const result = await applyPackUpdate(clone.id)
    expect(result).toBeDefined()
    expect(result?.noBaseline).toBe(false)
    expect(result?.packVersion).toBe("2.0.0")
    expect(result?.overwrittenFields.sort()).toEqual(
      ["allowedTools", "description", "systemPrompt"].sort()
    )

    const after = await getDb().characters.get(clone.id)
    expect(after?.systemPrompt).toBe("v2 prompt for alice")
    expect(after?.description).toBe("v2 description")
    expect(after?.allowedTools).toEqual(["Read", "Bash"])
    expect(after?.packVersionAtClone).toBe("2.0.0")
    expect(after?.pristineSnapshot?.systemPrompt).toBe("v2 prompt for alice")
  })

  it("preserves fields the user has edited since the last clone", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice")]), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    // User edits the systemPrompt.
    await getDb().characters.update(clone.id, { systemPrompt: "MY EDIT", updatedAt: Date.now() })

    registerCharacterPack(
      PACK_ID,
      makePack([makeChar("alice", { systemPrompt: "v2 prompt", description: "v2 desc" })], {
        version: "2.0.0",
      }),
      { pluginId: PLUGIN_ID }
    )

    const result = await applyPackUpdate(clone.id)
    expect(result?.preservedFields).toContain("systemPrompt")
    expect(result?.overwrittenFields).toContain("description")
    expect(result?.overwrittenFields).not.toContain("systemPrompt")

    const after = await getDb().characters.get(clone.id)
    expect(after?.systemPrompt).toBe("MY EDIT")
    expect(after?.description).toBe("v2 desc")
  })

  it("returns undefined for rows that aren't pack clones", async () => {
    const row = await getDb().characters.add({
      id: "char_plain",
      name: "Plain",
      avatarColor: "x",
      systemPrompt: "x",
      createdAt: 0,
      updatedAt: 0,
    })
    expect(row).toBe("char_plain")
    expect(await applyPackUpdate("char_plain")).toBeUndefined()
  })

  it("returns undefined when the overlay pack has been unregistered", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice")]), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    __resetCharacterPacksForTesting()
    expect(await applyPackUpdate(clone.id)).toBeUndefined()
  })

  it("falls back to overwrite-all when pristineSnapshot is missing", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice")]), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    // Simulate a legacy v48 clone — strip the snapshot.
    await getDb()
      .characters.where("id")
      .equals(clone.id)
      .modify((obj) => {
        const r = obj as unknown as Record<string, unknown>
        delete r.pristineSnapshot
      })

    registerCharacterPack(
      PACK_ID,
      makePack([makeChar("alice", { systemPrompt: "v2 prompt" })], { version: "2.0.0" }),
      { pluginId: PLUGIN_ID }
    )
    const result = await applyPackUpdate(clone.id)
    expect(result?.noBaseline).toBe(true)
    const after = await getDb().characters.get(clone.id)
    expect(after?.systemPrompt).toBe("v2 prompt")
    expect(after?.pristineSnapshot).toBeDefined()
  })

  it("deletes a row field when the overlay drops it", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice", { description: "v1 desc" })]), {
      pluginId: PLUGIN_ID,
    })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    // New pack version drops description entirely.
    const v2 = makeChar("alice")
    delete (v2 as Partial<PluginCharacterDef>).description
    registerCharacterPack(PACK_ID, makePack([v2], { version: "2.0.0" }), { pluginId: PLUGIN_ID })
    await applyPackUpdate(clone.id)
    const after = await getDb().characters.get(clone.id)
    expect(after?.description).toBeUndefined()
  })
})

describe("previewPackUpdate", () => {
  it("returns the diff without writing to Dexie", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice")]), { pluginId: PLUGIN_ID })
    const clone = await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    registerCharacterPack(
      PACK_ID,
      makePack([makeChar("alice", { systemPrompt: "v2 prompt" })], { version: "2.0.0" }),
      { pluginId: PLUGIN_ID }
    )
    const preview = await previewPackUpdate(clone.id)
    expect(preview?.packVersion).toBe("2.0.0")
    expect(preview?.diff.willOverwrite.some((f) => f.field === "systemPrompt")).toBe(true)
    // Dexie row is untouched.
    const after = await getDb().characters.get(clone.id)
    expect(after?.systemPrompt).toBe("v1 prompt for alice")
  })
})

describe("applyPackUpdateForPack", () => {
  it("applies updates to every clone of the named pack", async () => {
    registerCharacterPack(PACK_ID, makePack([makeChar("alice"), makeChar("bob")]), {
      pluginId: PLUGIN_ID,
    })
    await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "alice"))
    await duplicateCharacter(buildOverlayCharacterId(PLUGIN_ID, PACK_ID, "bob"))

    registerCharacterPack(
      PACK_ID,
      makePack(
        [
          makeChar("alice", { systemPrompt: "v2 alice" }),
          makeChar("bob", { systemPrompt: "v2 bob" }),
        ],
        { version: "2.0.0" }
      ),
      { pluginId: PLUGIN_ID }
    )

    const results = await applyPackUpdateForPack(PLUGIN_ID, PACK_ID)
    expect(results).toHaveLength(2)
    const rows = await getDb().characters.toArray()
    const alice = rows.find((r) => r.clonedFromPackCharacterId?.endsWith(":alice"))
    const bob = rows.find((r) => r.clonedFromPackCharacterId?.endsWith(":bob"))
    expect(alice?.systemPrompt).toBe("v2 alice")
    expect(bob?.systemPrompt).toBe("v2 bob")
  })

  it("returns an empty array when no clones exist", async () => {
    const results = await applyPackUpdateForPack(PLUGIN_ID, PACK_ID)
    expect(results).toEqual([])
  })
})
