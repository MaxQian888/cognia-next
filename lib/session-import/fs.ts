// Real `SessionFs` over `lib/file/file-operations.ts`. Mirrors the `realFs()`
// helper in `hooks/memory/use-external-memory.ts`, extended with the content
// read the adapters need. Desktop-only for directory walks; the picker path
// supplies file contents directly and never touches this.

import { joinPath } from "@/lib/claude/instructions/paths"
import { mapBounded } from "./pacing"
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
    async readDirEntries(path) {
      const { readDirEntries } = await import("@/lib/file/file-operations")
      return readDirEntries(path)
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
 * In-flight stat/readDir IPC calls during a walk. Eight lanes cut the
 * date-nested Codex tree's serial round-trips roughly eight-fold while
 * keeping nested recursion fan-out bounded (each level still caps its own).
 */
const WALK_IPC_LANES = 8

/**
 * Recursively list every file path under `dir` whose full path satisfies
 * `predicate`. Tolerant of unreadable subdirectories (skips them), and bounded
 * by {@link MAX_WALK_DEPTH}. Used by the date-nested Codex scan and the flat
 * Claude Code scan alike.
 *
 * The predicate receives the full path, not the basename: suffix predicates
 * (`.jsonl`, `.md`) behave identically either way, but predicates that scope
 * by directory segment (`/teams/`, `/tasks/<name>/`) only work on full paths —
 * claude-code's `readJsonFiles` silently matched nothing when the argument
 * was the basename.
 */
export async function walkFiles(
  fs: SessionFs,
  dir: string,
  predicate: (path: string) => boolean,
  depth = 0
): Promise<string[]> {
  const out: string[] = []
  if (depth > MAX_WALK_DEPTH) return out
  // `readDirEntries` reports each entry's type for free — the real fs gets it
  // from `plugin-fs` `readDir` — so the desktop walk costs one IPC per
  // DIRECTORY instead of one per ENTRY. Fakes/other implementations that only
  // have `readDir` fall back to the per-entry `stat` path below.
  let entries: Array<{ name: string; isFile?: boolean }>
  try {
    entries = fs.readDirEntries
      ? await fs.readDirEntries(dir)
      : (await fs.readDir(dir)).map((name) => ({ name }))
  } catch {
    return out
  }
  // Stats and subdirectory descents run over bounded lanes: every stat/readDir
  // is a Tauri IPC, so a serial walk pays one round-trip per directory — the
  // date-nested Codex tree (sessions/YYYY/MM/DD) has hundreds. Order matches
  // the old serial walk (mapBounded preserves input order).
  const nested = await mapBounded(entries, WALK_IPC_LANES, async (entry) => {
    const full = joinPath(dir, entry.name)
    let isFile = entry.isFile
    if (isFile === undefined) {
      try {
        isFile = (await fs.stat(full)).isFile
      } catch {
        return null
      }
    }
    if (isFile) return predicate(full) ? [full] : null
    return walkFiles(fs, full, predicate, depth + 1)
  })
  for (const files of nested) {
    if (files) out.push(...files)
  }
  return out
}
