/**
 * The workspace sensitive-file floor (ADR-0222 §9.3) on the TypeScript side.
 *
 * One list for both languages: `crates/cognia-files/fixtures/sensitive-paths.json`.
 * The Rust walker (`is_sensitive_workspace_path` in `crates/cognia-files`)
 * pins its constants to that file, and this module reads it directly, so the
 * two cannot drift; both run the file's conformance cases.
 *
 * Used where a selection is assembled on the client — a Dexie mount has no
 * Rust walk in front of it, and a file the user picked one by one never went
 * through the walk at all. Matching is ASCII case-insensitive, like Rust's
 * `to_ascii_lowercase`.
 */

import fixture from "@/crates/cognia-files/fixtures/sensitive-paths.json"

const FILE_NAMES = new Set(fixture.fileNames)
const ENV_TEMPLATE_SUFFIXES = new Set(fixture.envTemplateSuffixes)
const EXTENSIONS = new Set(fixture.extensions)
const DIRECTORIES = new Set(fixture.directories)
const DIRECTORY_PAIRS = fixture.directoryPairs.map(([parent, child]) => `${parent}/${child}`)

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

/** Whether a file named `name` is refused by the floor. */
export function isSensitiveFileName(name: string): boolean {
  const lower = asciiLower(name)
  if (FILE_NAMES.has(lower)) return true
  // `.env.production`, `.env.local`, … but not `.env.example`/`.env.sample`.
  if (lower.startsWith(".env.")) return !ENV_TEMPLATE_SUFFIXES.has(lower.slice(".env.".length))
  // Private keys keep their base name and gain an extension.
  const dot = lower.lastIndexOf(".")
  if (dot >= 0) {
    if (EXTENSIONS.has(lower.slice(dot + 1))) return true
    if (FILE_NAMES.has(lower.slice(0, dot))) return true
  }
  return false
}

/** Whether a directory named `name`, inside one named `parent`, is refused whole. */
export function isSensitiveDirectory(parent: string | undefined, name: string): boolean {
  const lower = asciiLower(name)
  if (DIRECTORIES.has(lower)) return true
  if (parent === undefined) return false
  return DIRECTORY_PAIRS.includes(`${asciiLower(parent)}/${lower}`)
}

/**
 * Whether a `/`-separated path (relative to a root, or a whole FileSpace path)
 * is refused: its file name, or any directory on the way to it.
 */
export function isSensitivePath(path: string): boolean {
  const segments = path.split(/[/\\]/).filter((segment) => segment.length > 0)
  const file = segments.pop()
  if (file === undefined) return false
  let parent: string | undefined
  for (const directory of segments) {
    if (isSensitiveDirectory(parent, directory)) return true
    parent = directory
  }
  return isSensitiveFileName(file)
}
