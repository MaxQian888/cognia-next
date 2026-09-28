// Native history scans use a dedicated confined read-only command.
// Picker imports supply contents directly and never touch the filesystem.

import { joinPath } from "@/lib/claude/instructions/paths"
import { isTauri } from "@/lib/platform/detect"
import { mapBounded } from "./pacing"
import type { SessionFs } from "./types"

type HistoryFsResults = {
  readText: { kind: "text"; content: string }
  readDir: { kind: "directory"; entries: Array<{ name: string; isFile?: boolean }> }
  stat: { kind: "stat"; exists: boolean; size: number; isFile: boolean }
}

async function readNativeHistory<K extends keyof HistoryFsResults>(
  operation: K,
  path: string
): Promise<HistoryFsResults[K]> {
  const { invoke } = await import("@tauri-apps/api/core")
  const result = await invoke<HistoryFsResults[K]>("session_import_fs", { operation, path })
  const expected = { readText: "text", readDir: "directory", stat: "stat" }[operation]
  if (result.kind !== expected)
    throw new Error(`Unexpected history filesystem response: ${result.kind}`)
  return result
}

/** Read-only native history access. Picker contents bypass this adapter. */
export function realSessionFs(): SessionFs {
  return {
    async exists(path) {
      if (isTauri()) return (await readNativeHistory("stat", path)).exists
      const { exists } = await import("@/lib/file/file-operations")
      return exists(path)
    },
    async readDir(path) {
      if (isTauri())
        return (await readNativeHistory("readDir", path)).entries.map((entry) => entry.name)
      const { readDir } = await import("@/lib/file/file-operations")
      return readDir(path)
    },
    async readDirEntries(path) {
      if (isTauri()) return (await readNativeHistory("readDir", path)).entries
      const { readDirEntries } = await import("@/lib/file/file-operations")
      return readDirEntries(path)
    },
    async stat(path) {
      if (isTauri()) {
        const result = await readNativeHistory("stat", path)
        if (!result.exists) throw new Error(`History path does not exist: ${path}`)
        return { size: result.size, isFile: result.isFile }
      }
      const { statFile } = await import("@/lib/file/file-operations")
      const s = await statFile(path)
      return { size: s.size, isFile: s.isFile }
    },
    async readTextFile(path) {
      if (isTauri()) return (await readNativeHistory("readText", path)).content
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
  // from the native history reader — so the desktop walk costs one IPC per
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
