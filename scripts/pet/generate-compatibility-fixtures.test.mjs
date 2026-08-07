import assert from "node:assert/strict"
import test from "node:test"
import JSZip from "jszip"
import {
  fixtureSha256,
  generatePetCompatibilityFixtures,
} from "./generate-compatibility-fixtures.mjs"

test("generates a deterministic compatibility corpus without committed binaries", async () => {
  const first = await generatePetCompatibilityFixtures()
  const second = await generatePetCompatibilityFixtures()
  for (const key of [
    "nestedMultiModelZip",
    "pathCollisionZip",
    "missingAncillaryZip",
    "invalidTextureZip",
  ]) {
    assert.equal(fixtureSha256(first[key]), fixtureSha256(second[key]))
  }
  assert.equal(first.largeModel.declaredBytes, 50 * 1024 * 1024 + 1)
  assert.deepEqual(first.spriteV2.valid, {
    spriteVersionNumber: 2,
    width: 1536,
    height: 2288,
    mime: "image/webp",
  })
})

test("covers nested models, collisions, traversal and missing ancillary resources", async () => {
  const fixtures = await generatePetCompatibilityFixtures()
  const nested = await JSZip.loadAsync(fixtures.nestedMultiModelZip)
  assert.ok(nested.file("bundle/alpha/model.model3.json"))
  assert.ok(nested.file("bundle/nested/beta/model.model3.json"))

  const collision = await JSZip.loadAsync(fixtures.pathCollisionZip)
  assert.ok(collision.file("collision/TEXTURES/texture_00.png"))
  // JSZip deliberately sanitizes traversal while loading; the raw-entry
  // validator fixture therefore travels separately from the archive bytes.
  assert.deepEqual(fixtures.traversalEntries, ["../escape.txt", "safe/model.model3.json"])

  const degraded = await JSZip.loadAsync(fixtures.missingAncillaryZip)
  const settings = JSON.parse(await degraded.file("degraded/model.model3.json").async("text"))
  assert.equal(settings.FileReferences.Motions.Idle[0].Sound, "sounds/missing.wav")
  assert.equal(degraded.file("degraded/motions/missing.motion3.json"), null)
})
