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
    if (depth > MAX_DEPTH) {
      throw new Error(`plugin source exceeds maximum directory depth ${MAX_DEPTH}: ${relative}`)
    }
    let names: string[]
    try {
      names = await fs.readDir(absolute)
    } catch (error) {
      throw new Error(`cannot read plugin source directory ${absolute}: ${String(error)}`)
    }
    for (const name of names) {
      if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
        throw new Error(`invalid plugin source directory entry: ${name}`)
      }
      seen += 1
      if (seen > MAX_SNAPSHOT_ENTRIES) {
        throw new Error(
          `plugin source contains more than ${MAX_SNAPSHOT_ENTRIES} entries; choose the plugin directory itself`
        )
      }
      const childAbsolute = joinPath(absolute, name)
      const childRelative = relative ? `${relative}/${name}` : name
      let info: { size: number; isFile: boolean }
      try {
        info = await fs.stat(childAbsolute)
      } catch (error) {
        throw new Error(`cannot stat plugin source entry ${childRelative}: ${String(error)}`)
      }
      if (!info.isFile) {
        // Built outputs may be referenced by packaged MCP servers or runtimes.
        if (SNAPSHOT_SKIP_DIRS.has(name) && !["dist", "build", "out", "target"].includes(name))
          continue
        await walk(childAbsolute, childRelative, depth + 1)
        continue
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
      const text = await fs.readTextFile(childAbsolute)
      if (new TextEncoder().encode(text).byteLength > MAX_TEXT_FILE_BYTES) {
        throw new Error(`plugin text file is too large to convert safely: ${childRelative}`)
      }
      files.set(childRelative, text)
    }
  }

  await walk(sourceDir, "", 0)
  return { files, binaryPaths }
}
