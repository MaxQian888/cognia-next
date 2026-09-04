// Extracts a Live2D model `.zip` into `ModelFileEntry[]` using jszip. Directories
// are skipped; a single common top-level folder (the usual "ModelName/" wrapper)
// is stripped so the manifest's relative paths resolve. The `loadAsync` dep is
// injectable so tests can drive a fake archive without a real zip blob.

import JSZip from "jszip"
import { MAX_MODEL_BYTES } from "./constants"

import type { ModelFileEntry } from "./types"
import { normalizePath } from "./url-resolver"

interface ZipObjectLike {
  dir: boolean
  async(type: "blob"): Promise<Blob>
}

interface ZipLike {
  files: Record<string, ZipObjectLike>
}

export interface ZipDeps {
  loadAsync?: (data: Blob) => Promise<ZipLike>
}

export type ExtractZipResult =
  { ok: true; entries: ModelFileEntry[] } | { ok: false; code: "zipFailed" | "tooLarge" }

/**
 * Bounds applied DURING extraction, not after it.
 *
 * The 50 MiB model cap lives in `import-validate`, which runs once every entry
 * has already been decompressed into a Blob. An archive that is small on disk
 * but enormous once expanded, or one carrying an absurd number of members,
 * therefore got to allocate all of it before anything checked. These stop the
 * walk at the first entry that crosses a line.
 */
export const MAX_ZIP_ENTRIES = 2000
export const MAX_ZIP_ENTRY_BYTES = MAX_MODEL_BYTES
export const MAX_ZIP_TOTAL_BYTES = MAX_MODEL_BYTES

/**
 * Common single top-level folder shared by every path, or "" if none. Requires
 * at least two files so a lone `tex/t0.png` keeps its directory (a single file
 * isn't a wrapper folder to strip).
 */
function commonTopLevel(paths: string[]): string {
  if (paths.length < 2) return ""
  const firstSlash = paths[0].indexOf("/")
  if (firstSlash === -1) return ""
  const candidate = paths[0].slice(0, firstSlash + 1) // includes trailing slash
  return paths.every((p) => p.startsWith(candidate)) ? candidate : ""
}

function inferredMime(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".json")) return "application/json"
  return ""
}

export async function extractModelZip(blob: Blob, deps: ZipDeps = {}): Promise<ExtractZipResult> {
  const loadAsync = deps.loadAsync ?? ((data: Blob) => JSZip.loadAsync(data) as Promise<ZipLike>)

  let zip: ZipLike
  try {
    zip = await loadAsync(blob)
  } catch {
    return { ok: false, code: "zipFailed" }
  }

  try {
    const fileEntries = Object.entries(zip.files)
      .filter(([, obj]) => !obj.dir)
      .map(([path, obj]) => ({ path: path.replace(/\\/g, "/"), obj }))

    // Refuse an absurd member count before decompressing any of it.
    if (fileEntries.length > MAX_ZIP_ENTRIES) return { ok: false, code: "tooLarge" }

    const prefix = commonTopLevel(fileEntries.map((e) => e.path))

    const entries: ModelFileEntry[] = []
    let totalBytes = 0
    for (const { path, obj } of fileEntries) {
      const stripped = prefix ? path.slice(prefix.length) : path
      // A bare top-level folder entry could normalize to empty — skip it.
      if (normalizePath(stripped) === "") continue
      const fileBlob = await obj.async("blob")
      // Checked as the walk proceeds, so a compression bomb stops here rather
      // than after the whole archive has been expanded into memory.
      if (fileBlob.size > MAX_ZIP_ENTRY_BYTES) return { ok: false, code: "tooLarge" }
      totalBytes += fileBlob.size
      if (totalBytes > MAX_ZIP_TOTAL_BYTES) return { ok: false, code: "tooLarge" }
      const mime = inferredMime(stripped)
      entries.push({
        path: stripped,
        blob: mime && fileBlob.type !== mime ? new Blob([fileBlob], { type: mime }) : fileBlob,
      })
    }

    return { ok: true, entries }
  } catch {
    return { ok: false, code: "zipFailed" }
  }
}
