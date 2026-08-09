jest.mock("@/lib/db/pet-models", () => ({
  getPetModel: jest.fn(async (id: string) => ({ id, name: "Hiyori" })),
  getPetModelEntries: jest.fn(async () => [{ path: "model.moc3", blob: new Blob(["moc"]) }]),
}))
jest.mock("@/lib/db/pet-sprite-packs", () => ({
  getPetSpritePack: jest.fn(async (id: string) => ({ id, spritesheet: new Blob(["atlas"]) })),
}))

import { getPetModel } from "@/lib/db/pet-models"
import { getPetSpritePack } from "@/lib/db/pet-sprite-packs"
import { resetPetSkinRuntimeForTests } from "./skin-runtime"
import { invalidatePetSkinAsset, loadLive2dSkinAsset, loadSpriteSkinAsset } from "./skin-assets"

beforeEach(() => {
  resetPetSkinRuntimeForTests()
  jest.clearAllMocks()
})

it("loads each selected asset once per WebView until invalidated", async () => {
  await Promise.all([loadLive2dSkinAsset("m1"), loadLive2dSkinAsset("m1")])
  await Promise.all([loadSpriteSkinAsset("momo"), loadSpriteSkinAsset("momo")])
  expect(getPetModel).toHaveBeenCalledTimes(1)
  expect(getPetSpritePack).toHaveBeenCalledTimes(1)

  invalidatePetSkinAsset({ skinId: "live2d", modelId: "m1" })
  await loadLive2dSkinAsset("m1")
  expect(getPetModel).toHaveBeenCalledTimes(2)
})
