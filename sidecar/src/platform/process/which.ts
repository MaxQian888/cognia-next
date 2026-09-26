// `which`-style PATH lookup, with simulated-platform support for tests.

import { existsSync } from "node:fs"
import path from "node:path"

export interface PathLookupOptions {
  platform?: NodeJS.Platform
  /** The PATH value to search; defaults to the process PATH. */
  pathVar?: string
  /** The Windows PATHEXT value; defaults to the process PATHEXT. */
  pathext?: string
  exists?: (candidate: string) => boolean
}

/**
 * `which`-style lookup honoring `PATHEXT` on Windows when `name` has no
 * extension (so a bare `pwsh` matches `pwsh.exe`). Returns the matched leaf
 * (`name + ext`) on a hit, else null. All inputs are injectable for tests.
 */
export function findOnPathSync(name: string, opts: PathLookupOptions = {}): string | null {
  const platform = opts.platform ?? process.platform
  const isWin = platform === "win32"
  const pathVar = opts.pathVar ?? process.env.PATH ?? ""
  if (!pathVar) return null
  const exists = opts.exists ?? existsSync
  // Use platform-correct path semantics from the `platform` opt, not the host's
  // — `path.join`/`extname` are host-bound, which would break simulated-platform
  // unit tests (and, in theory, a non-native runner).
  const p = isWin ? path.win32 : path.posix
  const sep = isWin ? ";" : ":"
  const hasExt = p.extname(name) !== ""
  const exts =
    isWin && !hasExt
      ? (opts.pathext ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter((s) => s.length > 0)
      : [""]
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      if (exists(p.join(dir, name + ext))) return name + ext
    }
  }
  return null
}
