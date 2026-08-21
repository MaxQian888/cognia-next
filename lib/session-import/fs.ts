// Real `SessionFs` over `lib/file/file-operations.ts`. Mirrors the `realFs()`
// helper in `hooks/memory/use-external-memory.ts`, extended with the content
// read the adapters need. Desktop-only for directory walks; the picker path
// supplies file contents directly and never touches this.

import { joinPath } from "@/lib/claude/instructions/paths"
import type { SessionFs } from "./types"

/** Real filesystem adapter. Directory walks resolve to [] off-desktop. */
export function realSessionFs(): SessionFs {
  return {
    async exists(path) {
      const { exists } = await import("@/lib/file/file-operations")
      return exists(path)
    },
    async readDir(path) {
      const { readDir } = await import("@/lib/file/file-operations")
      return readDir(path)
    },
    async stat(path) {
      const { statFile } = await import("@/lib/file/file-operations")
      const s = await statFile(path)
      return { size: s.size, isFile: s.isFile }
    },
    async readTextFile(path) {
      const { readTextFile } = await import("@/lib/file/file-operations")
      return readTextFile(path)
    },
  }
}

/**
 * How deep {@link walkFiles} descends before giving up on a branch.
 *
 * The deepest real layout any source uses is Codex's `sessions/YYYY/MM/DD/` —
 * three levels below the root. 12 leaves a very wide margin while still being a
 * hard stop: a symlink loop inside a watched agent directory (`~/.claude` ->
 * `~`, a self-referential `node_modules`) would otherwise recurse until the
 * scan blew the stack, on a path the user cannot see and did not choose.
 */
const MAX_WALK_DEPTH = 12

/**
 * Recursively list every file path under `dir` whose basename matches
 * `predicate`. Tolerant of unreadable subdirectories (skips them), and bounded
 * by {@link MAX_WALK_DEPTH}. Used by the date-nested Codex scan and the flat
 * Claude Code scan alike.
 */
export async function walkFiles(
  fs: SessionFs,
  dir: string,
  predicate: (name: string) => boolean,
  depth = 0
): Promise<string[]> {
  const out: string[] = []
  if (depth > MAX_WALK_DEPTH) return out
  let names: string[]
  try {
    names = await fs.readDir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = joinPath(dir, name)
    let isFile: boolean
    try {
      isFile = (await fs.stat(full)).isFile
    } catch {
      continue
    }
    if (isFile) {
      if (predicate(name)) out.push(full)
    } else {
      out.push(...(await walkFiles(fs, full, predicate, depth + 1)))
    }
  }
  return out
}
