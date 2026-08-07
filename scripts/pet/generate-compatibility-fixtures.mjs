import { createHash } from "node:crypto"
import JSZip from "jszip"

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z")

const BASE_SETTINGS = {
  Version: 3,
  FileReferences: {
    Moc: "model.moc3",
    Textures: ["textures/texture_00.png"],
  },
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function add(zip, path, value) {
  zip.file(path, value, { date: FIXED_DATE, createFolders: false })
}

function addRenderableModel(zip, root, overrides = {}) {
  const settings = {
    ...BASE_SETTINGS,
    ...overrides,
    FileReferences: { ...BASE_SETTINGS.FileReferences, ...overrides.FileReferences },
  }
  add(zip, `${root}/model.model3.json`, json(settings))
  add(zip, `${root}/model.moc3`, "fixture-moc3")
  add(zip, `${root}/textures/texture_00.png`, "fixture-png")
}

async function archive(build) {
  const zip = new JSZip()
  build(zip)
  return zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
    platform: "UNIX",
  })
}

/**
 * Deterministic, generated-only failure corpus. Large binary models and image
 * atlases are represented by descriptors so tests never commit/generated 50MB
 * blobs; import seams inject the declared size/dimensions.
 */
export async function generatePetCompatibilityFixtures() {
  const nestedMultiModelZip = await archive((zip) => {
    addRenderableModel(zip, "bundle/alpha")
    addRenderableModel(zip, "bundle/nested/beta")
  })
  const pathCollisionZip = await archive((zip) => {
    addRenderableModel(zip, "collision")
    add(zip, "collision/TEXTURES/texture_00.png", "ambiguous-png")
    add(zip, "collision/textures/./texture_00.png", "duplicate-normalized-png")
    add(zip, "../escape.txt", "traversal")
  })
  const missingAncillaryZip = await archive((zip) => {
    addRenderableModel(zip, "degraded", {
      FileReferences: {
        Motions: { Idle: [{ File: "motions/missing.motion3.json", Sound: "sounds/missing.wav" }] },
        Expressions: [{ Name: "smile", File: "expressions/missing.exp3.json" }],
        Physics: "missing.physics3.json",
        Pose: "missing.pose3.json",
      },
    })
  })
  const invalidTextureZip = await archive((zip) => {
    addRenderableModel(zip, "invalid-texture")
    add(zip, "invalid-texture/textures/texture_00.png", "not-an-image")
  })

  return {
    nestedMultiModelZip,
    pathCollisionZip,
    traversalEntries: ["../escape.txt", "safe/model.model3.json"],
    missingAncillaryZip,
    invalidTextureZip,
    largeModel: { declaredBytes: 50 * 1024 * 1024 + 1 },
    asymmetricModel: { width: 320, height: 2048 },
    spriteV2: {
      valid: { spriteVersionNumber: 2, width: 1536, height: 2288, mime: "image/webp" },
      invalid: { spriteVersionNumber: 1, width: 1535, height: 2288, mime: "image/gif" },
    },
  }
}

export function fixtureSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}
