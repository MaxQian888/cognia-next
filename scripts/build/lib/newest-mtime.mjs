// Shared by the sidecar build scripts (ADR-0068 C4): compute the newest
// mtime under a directory so a prebuild `tsc` can be skipped when the
// existing dist output is already newer than every source file.

import { readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"])

/**
 * Newest mtime (ms) of any file under `dir`, recursively. Returns 0 when the
 * directory does not exist so callers treat "no sources" as "always stale".
 * `exts` (e.g. [".ts", ".json"]) filters by file extension; omit to consider
 * every file. `node_modules`, `dist`, and `.git` subtrees are always skipped.
 */
export function newestMtimeMs(dir, { exts } = {}) {
  let newest = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      newest = Math.max(newest, newestMtimeMs(full, { exts }))
    } else if (entry.isFile()) {
      if (exts && !exts.includes(extname(entry.name))) continue
      try {
        newest = Math.max(newest, statSync(full).mtimeMs)
      } catch {
        // racing deletion — ignore
      }
    }
  }
  return newest
}
