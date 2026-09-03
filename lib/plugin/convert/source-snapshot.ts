/**
 * The shared shape and bounds of a plugin-bundle snapshot.
 *
 * `convertPluginBundle` takes a `Map<relativePath, text>` where non-text files
 * are present as empty-string placeholders so a resource-bearing skill stays a
 * bundle. Three callers build that map: the GitHub installer walks a repo tree
 * (`lib/plugin/package/github-source.ts`), the agent service walks a workspace
 * (`lib/plugin/convert/agent-service.ts`), and the Load-unpacked flow walks a
 * picked directory (`lib/plugin/local/local-source-snapshot.ts`).
 *
 * They each had their own copy of the extension list and the two limits, and
 * the limits are the only thing standing between "convert a plugin" and
 * "serialise a node_modules tree through IPC". One definition, three callers.
 */

/** Extensions read as text. Everything else is a placeholder plus a path. */
export const SNAPSHOT_TEXT_FILE_PATTERN =
  /\.(?:md|markdown|txt|json|jsonc|toml|ya?ml|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rs|css|html)$/i

/** Hard ceiling on entries walked before the source is refused. */
export const MAX_SNAPSHOT_ENTRIES = 2_000

/** Hard ceiling on a single text file. */
export const MAX_TEXT_FILE_BYTES = 1_000_000

/**
 * Directory names never descended into.
 *
 * A repo checkout is a plausible thing for someone to point Load unpacked at,
 * and `node_modules` alone will blow `MAX_SNAPSHOT_ENTRIES` before the walk
 * reaches anything a converter cares about. Refusing the whole source at that
 * point would be technically correct and useless.
 */
export const SNAPSHOT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
])

/** True when this path should be read as text rather than placeheld. */
export function isSnapshotTextFile(relativePath: string): boolean {
  return SNAPSHOT_TEXT_FILE_PATTERN.test(relativePath)
}

/**
 * Which converted files differ from what the source already contained.
 *
 * The installers copy the source tree verbatim and then overlay only what
 * conversion actually changed, so an unchanged file is never rewritten and the
 * overlay stays small enough for the installer's allowlist to police. This was
 * inlined in the GitHub path and needed identically by the local one.
 */
export function generatedFilesFrom(
  snapshot: ReadonlyMap<string, string>,
  converted: ReadonlyMap<string, string>
): Record<string, string> {
  const generated: Record<string, string> = {}
  for (const [path, contents] of converted) {
    if (snapshot.get(path) !== contents) generated[path] = contents
  }
  return generated
}
