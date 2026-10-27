import JSZip from "jszip"
import { extractMediaPackZip, importMediaPack } from "./import"

// Small boundary budgets exercise streaming rejection without allocating a huge ZIP bomb.
jest.mock("./manifest", () => ({
  ...jest.requireActual("./manifest"),
  MAX_MEDIA_PACK_BYTES: 1024,
  MAX_MEDIA_PACK_FILES: 3,
}))

it("rejects excess files and aggregate input bytes before parsing configuration", async () => {
  await expect(
    importMediaPack(Array.from({ length: 4 }, (_, i) => ({ path: `${i}.webp`, blob: new Blob() })))
  ).rejects.toMatchObject({ code: "tooLarge" })
  await expect(
    importMediaPack([{ path: "config.jsonc", blob: new Blob([new Uint8Array(1025)]) }])
  ).rejects.toMatchObject({ code: "tooLarge" })
})
it("stops decompression when a compact ZIP expands beyond the media budget", async () => {
  const bytes = await new JSZip()
    .file("idle.png", new Uint8Array(8192))
    .generateAsync({ type: "uint8array", compression: "DEFLATE" })
  expect(bytes.byteLength).toBeLessThan(1024)
  await expect(extractMediaPackZip(new Blob([new Uint8Array(bytes)]))).rejects.toMatchObject({
    code: "tooLarge",
  })
})
