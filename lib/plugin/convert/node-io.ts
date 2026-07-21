/**
 * The real `ConvertIo` implementation, backed by `node:fs`.
 *
 * Kept out of `cli.ts` so that module stays importable (and fully
 * testable) in the renderer-flavoured jest project, where `node:fs` is not
 * something we want pulled into the graph. Only the bundled binary entry
 * reaches for this file.
 */

import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { ConvertIo } from "./cli"

/** Directories never worth walking when collecting a skill's resources. */
const SKIPPED_DIRS = new Set([".git", "node_modules", ".DS_Store"])

function walk(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      walk(root, full, out)
    } else if (entry.isFile()) {
      out.push(relative(root, full).split("\\").join("/"))
    }
  }
}

export const nodeIo: ConvertIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, contents) => writeFileSync(path, contents, "utf8"),
  copyFile: (from, to) => copyFileSync(from, to),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  exists: (path) => existsSync(path),
  isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
  readDir: (path) => readdirSync(path),
  listFiles: (path) => {
    const out: string[] = []
    walk(path, path, out)
    return out
  },
  join: (...segments) => join(...segments),
  basename: (path) => basename(path),
  resolve: (path) => resolve(path),
  gitAuthor: () => {
    try {
      const name = execFileSync("git", ["config", "user.name"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
      return name || undefined
    } catch {
      // No git, no repository, or no configured name — the caller falls
      // back to a placeholder the author can override with --author.
      return undefined
    }
  },
}

export { dirname }
