/**
 * Read a picked plugin directory into the map `convertPluginBundle` consumes.
 *
 * The local twin of `fetchGithubPluginPreview`'s repo walk. It exists because
 * "Load unpacked" could only ever read `<dir>/plugin.json`: point it at a
 * Claude Code plugin and it threw a raw error, with no hint that the very same
 * bundle installs fine from GitHub because that path converts it.
 *
 * Bounds come from `lib/plugin/convert/source-snapshot`, shared with the two
 * existing snapshot walkers. They matter more here than there: the user picks
 * this directory, and picking a repo checkout is a plausible mistake.
 *
 * Injectable fs so the whole thing is testable without a desktop shell.
 */

import { joinPath } from "@/lib/claude/instructions/paths"
import {
  MAX_SNAPSHOT_ENTRIES,
  MAX_TEXT_FILE_BYTES,
  SNAPSHOT_SKIP_DIRS,
  isSnapshotTextFile,
} from "@/lib/plugin/convert/source-snapshot"

/** How deep the walk descends. Matches `lib/session-import/fs.ts`'s ceiling. */
const MAX_DEPTH = 12

export interface LocalSourceFs {
  readDir(path: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; isFile: boolean }>
  readTextFile(path: string): Promise<string>
}

export interface LocalPluginSourceSnapshot {
  /** Relative path to contents. Non-text files are present as "". */
  files: Map<string, string>
  /** Relative paths that were placeheld rather than read. */
  binaryPaths: Set<string>
}

function realFs(): LocalSourceFs {
  return {
    async readDir(path) {
      const { readDir } = await import("@/lib/file/file-operations")
      return readDir(path)
    },
    async stat(path) {
      const { statFile } = await import("@/lib/file/file-operations")
      const info = await statFile(path)
      return { size: info.size, isFile: info.isFile }
    },
    async readTextFile(path) {
      const { readTextFile } = await import("@/lib/file/file-operations")
      return readTextFile(path)
    },
  }
}

/**
 * Snapshot `sourceDir` for conversion.
 *
 * Throws rather than truncating when a bound is exceeded. A silently partial
 * snapshot converts to a silently partial plugin, and the whole point of the
 * conversion report is that the user is told what did not make it.
 */
export async function collectLocalPluginSource(
  sourceDir: string,
  fs: LocalSourceFs = realFs()
): Promise<LocalPluginSourceSnapshot> {
  const files = new Map<string, string>()
  const binaryPaths = new Set<string>()
  let seen = 0

  const walk = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    let names: string[]
    try {
      names = await fs.readDir(absolute)
    } catch {
      // An unreadable subdirectory is skipped, matching `walkFiles`. An
      // unreadable ROOT is not: `inspectLocalPluginSource` fails on the empty
      // snapshot, because "this directory holds no plugin" and "this directory
      // could not be read" must not look the same.
      return
    }
    for (const name of names) {
      const childAbsolute = joinPath(absolute, name)
      const childRelative = relative ? `${relative}/${name}` : name
      let info: { size: number; isFile: boolean }
      try {
        info = await fs.stat(childAbsolute)
      } catch {
        continue
      }
      if (!info.isFile) {
        if (SNAPSHOT_SKIP_DIRS.has(name)) continue
        await walk(childAbsolute, childRelative, depth + 1)
        continue
      }
      seen += 1
      if (seen > MAX_SNAPSHOT_ENTRIES) {
        throw new Error(
          `plugin source contains more than ${MAX_SNAPSHOT_ENTRIES} files; choose the plugin directory itself`
        )
      }
      if (!isSnapshotTextFile(childRelative)) {
        // Keep the path so resource-bearing skills stay bundles. The installer
        // copies the original bytes and never overlays them.
        files.set(childRelative, "")
        binaryPaths.add(childRelative)
        continue
      }
      if (info.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(`plugin text file is too large to convert safely: ${childRelative}`)
      }
      files.set(childRelative, await fs.readTextFile(childAbsolute))
    }
  }

  await walk(sourceDir, "", 0)
  return { files, binaryPaths }
}
