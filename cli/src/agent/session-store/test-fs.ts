/**
 * In-memory {@link SessionStoreFs} used by the session-store suites.
 *
 * Lives in a source file (not a `*.test.ts`) so every suite in this directory
 * shares ONE fake. Divergent per-suite fakes are how a store passes its own
 * tests while corrupting real disk: the fake must model the two properties the
 * store actually relies on — exclusive create really is exclusive, and an
 * atomic write really is all-or-nothing.
 */

import path from "node:path"

import type { SessionStoreFs } from "./paths"

export interface MemoryFs extends SessionStoreFs {
  /** Raw file table, for assertions about what actually landed. */
  readonly files: Map<string, string>
  /** Directories that exist (implicitly created by writes). */
  readonly dirs: Set<string>
  /** Make the next `writeFileAtomic` for `absPath` throw, simulating a crash. */
  failNextWrite(absPath: string): void
}

export function createMemoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const failures = new Set<string>()

  const ensureParents = (absPath: string): void => {
    let dir = path.dirname(absPath)
    while (dir && dir !== path.dirname(dir)) {
      dirs.add(dir)
      dir = path.dirname(dir)
    }
  }
  for (const key of files.keys()) ensureParents(key)

  return {
    files,
    dirs,
    failNextWrite(absPath) {
      failures.add(absPath)
    },
    exists: (p) => files.has(p) || dirs.has(p),
    isDirectory: (p) => dirs.has(p) && !files.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFileAtomic: (p, content) => {
      if (failures.delete(p)) throw new Error(`simulated write failure: ${p}`)
      ensureParents(p)
      files.set(p, content)
    },
    appendFile: (p, content) => {
      ensureParents(p)
      files.set(p, (files.get(p) ?? "") + content)
    },
    mkdirp: (dir) => {
      dirs.add(dir)
      ensureParents(path.join(dir, "x"))
    },
    readdir: (dir) => {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
      const names = new Set<string>()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const first = rest.split(path.sep)[0]
        if (first) names.add(first)
      }
      return [...names].sort()
    },
    removeFile: (p) => {
      files.delete(p)
    },
    removeDir: (p) => {
      const prefix = p.endsWith(path.sep) ? p : `${p}${path.sep}`
      for (const key of [...files.keys()]) {
        if (key === p || key.startsWith(prefix)) files.delete(key)
      }
      for (const key of [...dirs]) {
        if (key === p || key.startsWith(prefix)) dirs.delete(key)
      }
    },
    writeFileExclusive: (p, content) => {
      if (files.has(p)) return false
      ensureParents(p)
      files.set(p, content)
      return true
    },
    mtimeMs: (p) => (files.has(p) ? 0 : null),
  }
}
