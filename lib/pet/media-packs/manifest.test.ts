import { mediaPathSchema, validateMediaAsset, mediaManifestSchema } from "./manifest"

it.each([
  "/root",
  "../root",
  "x/../root",
  "file:secret",
  "https://example.com/a",
  "x\\a",
  "x//a",
  "x/./a",
])("rejects non-local media path %s", (path) => {
  expect(mediaPathSchema.safeParse(path).success).toBe(false)
})
it("requires an idle animation and known state references", () => {
  const manifest = {
    version: 1,
    source: "cognia",
    displayName: "Pet",
    width: 100,
    height: 100,
    clips: { idle: { kind: "frames", frames: ["a.webp"], frameMs: 42, loop: true } },
    states: { idle: ["missing"] },
  }
  expect(mediaManifestSchema.safeParse(manifest).success).toBe(false)
  manifest.states.idle = ["idle"]
  expect(mediaManifestSchema.safeParse(manifest).success).toBe(true)
  expect(
    validateMediaAsset({
      id: "mp_test",
      manifest,
      entries: [{ path: "a.webp", blob: new Blob(["image"]) }],
      totalBytes: 5,
      createdAt: 0,
    })
  ).toBe(true)
  expect(
    validateMediaAsset({ id: "mp_test", manifest, entries: [], totalBytes: 0, createdAt: 0 })
  ).toBe(false)
  for (const entry of [null, 1, "file", undefined])
    expect(
      validateMediaAsset({ id: "mp_test", manifest, entries: [entry], totalBytes: 0, createdAt: 0 })
    ).toBe(false)
})
