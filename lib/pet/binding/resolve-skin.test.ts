import { resolveCharacterSkinSelection, migrateLegacyPetBinding } from "./resolve-skin"

it("inherits the global selection when a character has no override", () => {
  expect(
    resolveCharacterSkinSelection({ skinId: "sprite-v2", activeSpritePackId: "momo" }, undefined)
  ).toEqual({ skinId: "sprite-v2", packId: "momo" })
})

it("prefers every typed per-character family", () => {
  expect(
    resolveCharacterSkinSelection(
      { skinId: "live2d", activeLive2dModelId: "global" },
      { characterId: "c", skin: { skinId: "svg" }, updatedAt: "" }
    )
  ).toEqual({ skinId: "svg" })
})

it("lazily migrates the dormant legacy Live2D id", () => {
  expect(
    migrateLegacyPetBinding({ characterId: "c", live2dModelId: "legacy", updatedAt: "old" }, "now")
  ).toEqual({
    characterId: "c",
    live2dModelId: "legacy",
    skin: { skinId: "live2d", modelId: "legacy" },
    updatedAt: "now",
  })
})
