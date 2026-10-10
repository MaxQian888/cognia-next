import { realpathSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * Whether `moduleUrl` is the script Node was started with. Node resolves
 * symlinks for `import.meta.url` but leaves `process.argv[1]` as typed, so a
 * launcher reached through a symlinked directory (macOS `/tmp`, a linked
 * install root) would otherwise decide it is a library and exit without doing
 * anything (ADR-0224 A1).
 */
export function isMainModule(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1]
): boolean {
  if (!argv1) return false
  if (moduleUrl === pathToFileURL(argv1).href) return true
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}
