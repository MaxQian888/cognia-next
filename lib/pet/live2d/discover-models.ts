// Discovers every Live2D model inside a flat file list (a picked folder or an
// extracted .zip), so a multi-model archive like `Live2d-model-master` can be
// imported selectively instead of being rejected for having >1 `.model3.json`.
//
// Each `*.model3.json` is one model. A model's files are grouped by LONGEST
// directory prefix: every file is assigned to the deepest model directory that
// contains it, so nested models and same-directory variants partition cleanly
// and a model keeps its whole subtree (textures, `motions/`, `expressions/`).
// Per-model validity reuses `validateLive2dImport` — this module only discovers
// and groups; it never re-implements validation or persistence.

import { validateLive2dImport } from "./import-validate"
import type { Live2dImportError, ModelFileEntry } from "./types"

/** A model found inside an import bundle, ready to list for selection. */
export interface DiscoveredModel {
  /** Stable identity within one discovery (the settings file's path). */
  key: string
  /** Display name derived from the settings filename. */
  name: string
  /** Settings file path — shown to disambiguate same-named models. */
  settingsPath: string
  /** This model's files only, grouped out of the bundle. */
  entries: ModelFileEntry[]
  /** Sum of this model's blob sizes (metadata only — no reads). */
  totalBytes: number
  /** Whether `validateLive2dImport` accepts this group. */
  valid: boolean
  /** Failure code when `!valid` (the UI maps it to localized copy). */
  errorCode?: Live2dImportError
}

/** Directory portion of a POSIX path ("a/b/c.json" → "a/b", "c.json" → ""). */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

function isModern(path: string): boolean {
  return path.toLowerCase().endsWith(".model3.json")
}

/** Derive a human name from a settings path ("a/Hiyori.model3.json" → "Hiyori"). */
export function deriveModelName(settingsPath: string): string {
  const base = settingsPath.slice(settingsPath.lastIndexOf("/") + 1)
  return base.replace(/\.model3?\.json$/i, "") || base
}

/** True when `filePath` lives under `dir` (the root dir "" contains everything). */
function isWithin(dir: string, filePath: string): boolean {
  return dir === "" || filePath === dir || filePath.startsWith(`${dir}/`)
}

export async function discoverLive2dModels(entries: ModelFileEntry[]): Promise<DiscoveredModel[]> {
  const settings = entries.filter((e) => isModern(e.path))
  if (settings.length === 0) return []

  // Candidate model directories. A directory may host more than one settings
  // file (outfit variants); longest-prefix ownership is resolved against these.
  const modelDirs = Array.from(new Set(settings.map((e) => dirname(e.path))))

  // Owner of a file = the deepest model directory that contains it.
  const ownerDir = (filePath: string): string | null => {
    let best: string | null = null
    for (const dir of modelDirs) {
      if (isWithin(dir, filePath) && (best === null || dir.length > best.length)) {
        best = dir
      }
    }
    return best
  }
  const owners = new Map<ModelFileEntry, string | null>()
  for (const e of entries) owners.set(e, ownerDir(e.path))

  const discovered = await Promise.all(
    settings.map(async (s): Promise<DiscoveredModel> => {
      const dir = dirname(s.path)
      // Files owned by this model's directory, minus OTHER settings files so
      // each group carries exactly one `*.model3.json` (validate requires that,
      // and same-directory variants must not poison each other).
      const group = entries.filter(
        (e) => owners.get(e) === dir && (e.path === s.path || !isModern(e.path))
      )
      const totalBytes = group.reduce((sum, e) => sum + e.blob.size, 0)
      const result = await validateLive2dImport(group)
      return {
        key: s.path,
        name: deriveModelName(s.path),
        settingsPath: s.path,
        entries: group,
        totalBytes,
        valid: result.ok,
        ...(result.ok ? {} : { errorCode: result.code }),
      }
    })
  )

  return discovered.sort((a, b) => a.settingsPath.localeCompare(b.settingsPath))
}
