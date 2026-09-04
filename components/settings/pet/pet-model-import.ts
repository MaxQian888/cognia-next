// Pure-ish import helpers for the Live2D model manager. Kept out of the React
// component so the component test can mock them and they can be unit-tested
// directly. All side effects (zip extraction, validation, persistence, network)
// are reached through the existing lib modules; `downloadSampleModel` takes an
// injectable fetch so tests drive it without a real network.

import { extractModelZip } from "@/lib/pet/live2d/zip"
import { validateLive2dImport } from "@/lib/pet/live2d/import-validate"
import { deriveModelName } from "@/lib/pet/live2d/discover-models"
import { addPetModel } from "@/lib/db/pet-models"
import type { Live2dImportError, ModelFileEntry } from "@/lib/pet/live2d/types"
import type { SampleModelEntry } from "@/lib/pet/live2d/constants"

// Re-exported from the discovery module (its canonical home) so existing
// importers/tests keep resolving it here.
export { deriveModelName }

/** Outcome of an import attempt — `ok` or a typed error code for the UI. */
export type ImportOutcome =
  { ok: true; id: string } | { ok: false; code: Live2dImportError | "downloadFailed" }

/**
 * Build `ModelFileEntry[]` from a `FileList` (or array of `File`). A single
 * `.zip` is extracted via jszip; a folder selection uses each file's
 * `webkitRelativePath` (falling back to its name) as the entry path.
 */
export async function filesToEntries(
  files: FileList | File[]
): Promise<
  { ok: true; entries: ModelFileEntry[] } | { ok: false; code: "zipFailed" | "tooLarge" }
> {
  const arr = Array.from(files as ArrayLike<File>)
  if (arr.length === 1 && arr[0].name.toLowerCase().endsWith(".zip")) {
    const result = await extractModelZip(arr[0])
    // Pass the real reason through. Collapsing everything to "couldn't be read"
    // told a user whose archive was simply too big to go looking for a corrupt
    // file instead.
    if (!result.ok) return { ok: false, code: result.code }
    return { ok: true, entries: result.entries }
  }
  const entries: ModelFileEntry[] = arr.map((f) => ({
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    blob: f,
  }))
  return { ok: true, entries }
}

/** Validate entries and, on success, persist a model row + its files. */
export async function importModelFromEntries(
  entries: ModelFileEntry[],
  meta: { source: "import" | "sample"; sampleId?: string }
): Promise<ImportOutcome> {
  const validated = await validateLive2dImport(entries)
  if (!validated.ok) return { ok: false, code: validated.code }

  const { manifest, totalBytes } = validated.model
  const row = await addPetModel(
    {
      name: deriveModelName(manifest.settingsPath),
      source: meta.source,
      sampleId: meta.sampleId,
      settingsPath: manifest.settingsPath,
      motionGroups: manifest.motionGroups,
      expressionIds: manifest.expressionIds,
      totalBytes,
      compatibility: validated.model.compatibility,
    },
    validated.model.entries.map((e) => ({ path: e.path, blob: e.blob }))
  )
  return { ok: true, id: row.id }
}

/**
 * Fetch every file of a sample catalog entry, validate, and persist. Returns a
 * `downloadFailed` code on any network error. `fetchImpl` is injectable for tests.
 */
export async function downloadSampleModel(
  entry: SampleModelEntry,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<ImportOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let entries: ModelFileEntry[]
  try {
    entries = await Promise.all(
      entry.files.map(async (file) => {
        const res = await fetchImpl(entry.baseUrl + file)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return { path: file, blob: await res.blob() }
      })
    )
  } catch {
    return { ok: false, code: "downloadFailed" }
  }
  return importModelFromEntries(entries, { source: "sample", sampleId: entry.id })
}
