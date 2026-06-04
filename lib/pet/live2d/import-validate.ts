// Validates a set of extracted model files into a ready-to-persist model, or a
// typed failure code. Rules, in order:
//   - find the settings file by name (`*.model3.json` → modern,
//     `*.model.json` → cubism2Unsupported when it's the only candidate)
//   - 0 settings → noSettings; >1 `*.model3.json` → multipleSettings
//   - parse the settings JSON (→ invalidJson / cubism2Unsupported)
//   - the moc and every texture must be present in the entries → missingReferenced
//   - optional files (motions / expressions / physics / pose) that are absent
//     are simply dropped from the manifest rather than failing the import
//   - total blob bytes over the cap → tooLarge
//
// The function is async because reading the settings JSON out of a `Blob`
// (`Blob.text()`) is async — there is no synchronous Blob-text accessor.

import { MAX_MODEL_BYTES } from "./constants"
import { parseLive2dManifest } from "./manifest"
import { readBlobText } from "./read-blob-text"
import type { ImportValidationResult, Live2DManifest, ModelFileEntry } from "./types"
import { normalizePath } from "./url-resolver"

function isModern(path: string): boolean {
  return path.toLowerCase().endsWith(".model3.json")
}

function isCubism2(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith(".model.json") && !lower.endsWith(".model3.json")
}

/** Drop manifest entries whose optional files are absent from `present`. */
function pruneOptional(manifest: Live2DManifest, present: Set<string>): Live2DManifest {
  const pruned: Live2DManifest = { ...manifest }
  if (pruned.physicsPath && !present.has(normalizePath(pruned.physicsPath))) {
    delete pruned.physicsPath
  }
  if (pruned.posePath && !present.has(normalizePath(pruned.posePath))) {
    delete pruned.posePath
  }
  return pruned
}

export async function validateLive2dImport(
  entries: ModelFileEntry[]
): Promise<ImportValidationResult> {
  const modern = entries.filter((e) => isModern(e.path))
  const cubism2 = entries.filter((e) => isCubism2(e.path))

  if (modern.length === 0) {
    if (cubism2.length > 0) {
      return { ok: false, code: "cubism2Unsupported" }
    }
    return { ok: false, code: "noSettings" }
  }
  if (modern.length > 1) {
    return { ok: false, code: "multipleSettings" }
  }

  const settings = modern[0]
  let jsonText: string
  try {
    jsonText = await readBlobText(settings.blob)
  } catch {
    return { ok: false, code: "invalidJson" }
  }

  const parsed = parseLive2dManifest(settings.path, jsonText)
  if (!parsed.ok) {
    return { ok: false, code: parsed.code }
  }
  const manifest = parsed.manifest

  const present = new Set(entries.map((e) => normalizePath(e.path)))

  // The moc and every texture are mandatory.
  const missing: string[] = []
  if (!present.has(normalizePath(manifest.mocPath))) {
    missing.push(manifest.mocPath)
  }
  for (const tex of manifest.texturePaths) {
    if (!present.has(normalizePath(tex))) {
      missing.push(tex)
    }
  }
  if (missing.length > 0) {
    return { ok: false, code: "missingReferenced", detail: missing.join(", ") }
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.blob.size, 0)
  if (totalBytes > MAX_MODEL_BYTES) {
    return { ok: false, code: "tooLarge", detail: String(totalBytes) }
  }

  return {
    ok: true,
    model: {
      manifest: pruneOptional(manifest, present),
      entries,
      totalBytes,
    },
  }
}
