// Extracts a Live2D model `.zip` into `ModelFileEntry[]` using jszip. Directories
// are skipped; a single common top-level folder (the usual "ModelName/" wrapper)
// is stripped so the manifest's relative paths resolve. The `loadAsync` dep is
// injectable so tests can drive a fake archive without a real zip blob.

import JSZip from "jszip"

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
  { ok: true; entries: ModelFileEntry[] } | { ok: false; code: "zipFailed" }

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

    const prefix = commonTopLevel(fileEntries.map((e) => e.path))

    const entries: ModelFileEntry[] = []
    for (const { path, obj } of fileEntries) {
      const stripped = prefix ? path.slice(prefix.length) : path
      // A bare top-level folder entry could normalize to empty — skip it.
      if (normalizePath(stripped) === "") continue
      const fileBlob = await obj.async("blob")
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
