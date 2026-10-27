jest.mock("@/lib/db/pet-models", () => ({
  getPetModel: jest.fn(async (id: string) => ({ id, name: "Hiyori" })),
  getPetModelEntries: jest.fn(async () => [{ path: "model.moc3", blob: new Blob(["moc"]) }]),
}))
jest.mock("@/lib/db/pet-sprite-packs", () => ({
  getPetSpritePack: jest.fn(async (id: string) => ({ id, spritesheet: new Blob(["atlas"]) })),
}))
jest.mock("./live2d/asset-bridge", () => ({
  isLive2dAssetMirror: jest.fn(() => false),
  requestMirroredLive2dAsset: jest.fn(),
  getMirroredLive2dRow: jest.fn(),
}))

import { getPetModel, getPetModelEntries } from "@/lib/db/pet-models"
import { getPetSpritePack } from "@/lib/db/pet-sprite-packs"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "./skin-runtime"
import { invalidatePetSkinAsset, loadLive2dSkinAsset, loadSpriteSkinAsset } from "./skin-assets"
import {
  isLive2dAssetMirror,
  requestMirroredLive2dAsset,
  getMirroredLive2dRow,
} from "./live2d/asset-bridge"

beforeEach(() => {
  resetPetSkinRuntimeForTests()
  jest.clearAllMocks()
  jest.mocked(isLive2dAssetMirror).mockReturnValue(false)
})

it("reads overlay assets from the account projection and reuses blobs with fresh metadata", async () => {
  jest.mocked(isLive2dAssetMirror).mockReturnValue(true)
  const row = { id: "m1", name: "Hiyori" } as Awaited<ReturnType<typeof getPetModel>>
  const entries = [{ path: "model.moc3", blob: new Blob(["moc"]) }]
  jest.mocked(requestMirroredLive2dAsset).mockResolvedValue({ row: row!, entries })
  jest.mocked(getMirroredLive2dRow).mockReturnValue(row)
  expect(await loadLive2dSkinAsset("m1")).toEqual({ row, entries })
  const saved = { ...row!, transform: { scale: 0.65, offsetX: 0.15, offsetY: 0 } }
  jest.mocked(getMirroredLive2dRow).mockReturnValue(saved)
  expect((await loadLive2dSkinAsset("m1"))?.row).toBe(saved)
  expect(requestMirroredLive2dAsset).toHaveBeenCalledTimes(1)
  expect(getPetModel).not.toHaveBeenCalled()
  expect(getPetModelEntries).not.toHaveBeenCalled()
})

it("reports an unavailable projection without falling back to the legacy database", async () => {
  jest.mocked(isLive2dAssetMirror).mockReturnValue(true)
  jest.mocked(requestMirroredLive2dAsset).mockResolvedValue(undefined)
  jest.mocked(getMirroredLive2dRow).mockReturnValue(undefined)
  expect(await loadLive2dSkinAsset("m1")).toBeUndefined()
  expect(getPetModel).not.toHaveBeenCalled()
  expect(getPetModelEntries).not.toHaveBeenCalled()
})

it("retries an unavailable projection rather than caching empty model files", async () => {
  jest.mocked(isLive2dAssetMirror).mockReturnValue(true)
  jest.mocked(requestMirroredLive2dAsset).mockResolvedValueOnce(undefined)
  jest.mocked(getMirroredLive2dRow).mockReturnValue(undefined)
  expect(await loadLive2dSkinAsset("m1")).toBeUndefined()
  const row = { id: "m1", name: "Hiyori" } as NonNullable<Awaited<ReturnType<typeof getPetModel>>>
  const entries = [{ path: "model.moc3", blob: new Blob(["moc"]) }]
  jest.mocked(getMirroredLive2dRow).mockReturnValue(row)
  jest.mocked(requestMirroredLive2dAsset).mockResolvedValue({ row, entries })
  expect(await loadLive2dSkinAsset("m1")).toEqual({ row, entries })
  expect(requestMirroredLive2dAsset).toHaveBeenCalledTimes(2)
})

it("does not let a superseded mirror request clear the replacement session cache", async () => {
  jest.mocked(isLive2dAssetMirror).mockReturnValue(true)
  let finish!: (value: undefined) => void
  jest.mocked(requestMirroredLive2dAsset).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const old = loadLive2dSkinAsset("m1")
  const runtime = getPetSkinRuntime()
  runtime.retryAsset("live2d:m1")
  const row = { id: "m1", name: "new account" } as NonNullable<
    Awaited<ReturnType<typeof getPetModel>>
  >
  const entries = [{ path: "model.moc3", blob: new Blob(["new"]) }]
  jest.mocked(getMirroredLive2dRow).mockReturnValue(row)
  jest.mocked(requestMirroredLive2dAsset).mockResolvedValue({ row, entries })
  expect(await loadLive2dSkinAsset("m1")).toEqual({ row, entries })
  finish(undefined)
  expect(await old).toBeUndefined()
  expect(runtime.retryGeneration("live2d:m1")).toBe(1)
  expect(await loadLive2dSkinAsset("m1")).toEqual({ row, entries })
  expect(requestMirroredLive2dAsset).toHaveBeenCalledTimes(2)
})

it("loads each selected asset once per WebView until invalidated", async () => {
  await Promise.all([loadLive2dSkinAsset("m1"), loadLive2dSkinAsset("m1")])
  await Promise.all([loadSpriteSkinAsset("momo"), loadSpriteSkinAsset("momo")])
  expect(getPetModel).toHaveBeenCalledTimes(2)
  expect(getPetModelEntries).toHaveBeenCalledTimes(1)
  expect(getPetSpritePack).toHaveBeenCalledTimes(1)

  invalidatePetSkinAsset({ skinId: "live2d", modelId: "m1" })
  await loadLive2dSkinAsset("m1")
  expect(getPetModel).toHaveBeenCalledTimes(3)
  expect(getPetModelEntries).toHaveBeenCalledTimes(2)
})
