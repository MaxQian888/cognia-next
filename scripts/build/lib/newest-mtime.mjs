// Shared by the sidecar build scripts (ADR-0068 C4): compute the newest
// mtime under a directory so a prebuild `tsc` can be skipped when the
// existing dist output is already newer than every source file.

import { statSync } from "node:fs"
import { extname } from "node:path"
import { globSync } from "glob"

const IGNORE_GLOBS = ["**/node_modules/**", "**/dist/**", "**/.git/**"]

/**
 * Newest mtime (ms) of any file under `dir`, recursively. Returns 0 when the
 * directory does not exist so callers treat "no sources" as "always stale".
 * `exts` (e.g. [".ts", ".json"]) filters by file extension; omit to consider
 * every file. `node_modules`, `dist`, and `.git` subtrees are always skipped.
 */
export function newestMtimeMs(dir, { exts } = {}) {
  let newest = 0
  let files
  try {
    files = globSync("**/*", {
      absolute: true,
      cwd: dir,
      dot: true,
      ignore: IGNORE_GLOBS,
      nodir: true,
    })
  } catch {
    return 0
  }
  for (const file of files) {
    if (exts && !exts.includes(extname(file))) continue
    try {
      newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {
      // Racing deletion — ignore.
    }
  }
  return newest
}
