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
 * Detect a trailing `@token` at the cursor. Returns the token (including `@`)
 * and its start offset, or null when the cursor is not in an `@` reference.
 */
export function activeAtToken(text: string): { token: string; start: number } | null {
  const match = /(^|\s)(@\S*)$/.exec(text)
  if (!match) return null
  const token = match[2]
  return { token, start: text.length - token.length }
}

/**
 * Completions for an `@`-token: matching entries as insertable path strings.
 *
 * Matching is case-insensitive (so `@S` finds `src/`), and dotfiles are hidden
 * unless the prefix itself starts with `.` (so `@` skips `.git`/`.env` noise but
 * `@.` reveals them). Directories sort first, then alphabetically.
 */
export function completeAtPath(token: string, listDir: ListDir): string[] {
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
    .map((e) => "@" + base + e.name + (e.isDir ? "/" : ""))
}
