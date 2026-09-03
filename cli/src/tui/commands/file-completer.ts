/**
 * `@path` file-path completion for the composer. Pure: the directory listing is
 * injected (`listDir`) so it unit-tests without touching the filesystem; the
 * `Input` component wires the real fs reader.
 */
export interface DirEntry {
  name: string
  isDir: boolean
}

export type ListDir = (dir: string) => DirEntry[]

/** Split a `@`-token into the directory to list and the prefix to match. */
export function splitToken(token: string): { dir: string; prefix: string } {
  const body = token.startsWith("@") ? token.slice(1) : token
  const slash = body.lastIndexOf("/")
  if (slash < 0) return { dir: ".", prefix: body }
  return { dir: body.slice(0, slash) || "/", prefix: body.slice(slash + 1) }
}

/**
 * Completions for a path token, each prefixed with `sigil` so it inserts ready
 * to use. The `@` composer reference uses the default sigil; the bash-mode
 * completer ({@link ../commands/bash-completer}) passes `""` for bare paths.
 *
 * Matching is case-insensitive (so `S` finds `src/`), and dotfiles are hidden
 * unless the prefix itself starts with `.` (so a bare prefix skips `.git`/`.env`
 * noise but `.` reveals them). Directories sort first, then alphabetically.
 */
export function completePath(token: string, listDir: ListDir, sigil = "@"): string[] {
  const { dir, prefix } = splitToken(token)
  let entries: DirEntry[]
  try {
    entries = listDir(dir)
  } catch {
    return []
  }
  const base = dir === "." ? "" : dir.replace(/\/$/, "") + "/"
  const lowerPrefix = prefix.toLowerCase()
  const wantsHidden = prefix.startsWith(".")
  return entries
    .filter((e) => {
      if (!wantsHidden && e.name.startsWith(".")) return false
      return e.name.toLowerCase().startsWith(lowerPrefix)
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .map((e) => sigil + base + e.name + (e.isDir ? "/" : ""))
}

/** Completions for an `@`-token: thin wrapper over {@link completePath}. */
export function completeAtPath(token: string, listDir: ListDir): string[] {
  return completePath(token, listDir, "@")
}
