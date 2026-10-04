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

/** Environment files must be overwritten, never restored from binary placeholders. */
export function isPluginEnvironmentFile(relativePath: string): boolean {
  return /(^|\/)\.env(?:\.|$)/.test(relativePath)
}

/**
 * Paths a conversion may write with arbitrary content. Mirrors
 * `GENERATED_FILE_PATHS` in `crates/cognia-plugin-runtime/src/generated_files.rs`.
 */
export const GENERATED_FILE_PATHS: readonly string[] = ["plugin.json", "dist/index.js"]

/**
 * The only contents a conversion may write over an EXISTING source file: an
 * empty JSON object (consumed vendor manifests and MCP configs, which may hold
 * literal credentials) or a bare newline (`.env*`). Mirrors
 * `NEUTRALIZED_CONTENTS` in `generated_files.rs`.
 */
export const NEUTRALIZED_CONTENTS: readonly string[] = ["{}\n", "\n"]

/** True when an overlay entry is something the Rust installers will apply. */
export function isOverlayEntryAllowed(
  snapshot: ReadonlyMap<string, string>,
  path: string,
  contents: string
): boolean {
  return (
    GENERATED_FILE_PATHS.includes(path) ||
    (snapshot.has(path) && NEUTRALIZED_CONTENTS.includes(contents))
  )
}

/**
 * Which converted files differ from what the source already contained.
 *
 * The installers copy the source tree verbatim and then overlay only what
 * conversion actually changed, so an unchanged file is never rewritten and the
 * overlay stays small enough for the installer's allowlist to police. This was
 * inlined in the GitHub path and needed identically by the local one.
 *
 * The overlay contract is the Rust one: generate `plugin.json` /
 * `dist/index.js`, or neutralize a file the source already has. Anything else
 * would be refused at install time, so it is refused here, at preview time,
 * with the offending paths named.
 */
export function generatedFilesFrom(
  snapshot: ReadonlyMap<string, string>,
  converted: ReadonlyMap<string, string>
): Record<string, string> {
  const generated: Record<string, string> = {}
  const refused: string[] = []
  for (const [path, contents] of converted) {
    if (snapshot.get(path) === contents) continue
    if (!isOverlayEntryAllowed(snapshot, path, contents)) refused.push(path)
    else generated[path] = contents
  }
  if (refused.length)
    throw new Error(
      `conversion changed files the plugin installers cannot overlay: ${refused.sort().join(", ")}`
    )
  return generated
}
