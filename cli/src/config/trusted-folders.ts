/**
 * Persistent "trusted folders" store, saved to `~/.cognia/trusted-folders.json`
 * as `{ "folders": ["/abs/path", …] }`.
 *
 * Claude Code asks "Do you trust the files in this folder?" the first time it is
 * launched in a directory, then remembers the answer. The standalone CLI had no
 * such gate — it dropped straight into chat against whatever `cwd` it inherited.
 * This module records the folders the user has confirmed, so the startup gate is
 * shown once per folder and skipped on every subsequent launch.
 *
 * Paths are normalized to their absolute, resolved form so `.`/`..`/trailing
 * separators all collapse to one canonical key.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface TrustedFoldersFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

const defaultFs: TrustedFoldersFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, data, "utf8")
  },
}

export function trustedFoldersPath(home: string): string {
  return path.join(home, "trusted-folders.json")
}

/** Canonical key for a folder: resolved absolute path (no trailing separator). */
function canonical(dir: string): string {
  return path.resolve(dir)
}

/** The set of folders the user has confirmed. Empty on missing/corrupt file. */
export function readTrustedFolders(home: string, fs: TrustedFoldersFs = defaultFs): Set<string> {
  const file = trustedFoldersPath(home)
  if (!fs.exists(file)) return new Set()
  try {
    const parsed = JSON.parse(fs.readText(file)) as { folders?: unknown }
    if (Array.isArray(parsed.folders)) {
      return new Set(parsed.folders.filter((n): n is string => typeof n === "string"))
    }
  } catch {
    // corrupt → empty
  }
  return new Set()
}

/** Whether `cwd` has been trusted before. */
export function isTrusted(home: string, cwd: string, fs: TrustedFoldersFs = defaultFs): boolean {
  return readTrustedFolders(home, fs).has(canonical(cwd))
}

/**
 * Record a folder as trusted and persist. Returns the new set. Idempotent —
 * trusting an already-trusted folder is a no-op write (keeps the file canonical).
 */
export function trustFolder(
  home: string,
  cwd: string,
  fs: TrustedFoldersFs = defaultFs
): Set<string> {
  const set = readTrustedFolders(home, fs)
  set.add(canonical(cwd))
  fs.writeText(trustedFoldersPath(home), JSON.stringify({ folders: [...set] }, null, 2))
  return set
}
