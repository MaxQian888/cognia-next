/**
 * File-path completion for bash shell-out mode (a `!command …` line). Pure: the
 * directory listing is injected (`listDir`), the same way `@`-mention completion
 * works — the `Input` component wires the real fs reader and reuses the mention
 * popup + {@link ../mention/accept} insertion for the candidates produced here.
 *
 * Only ARGUMENTS are completed, never the command name itself: a path token must
 * be preceded by whitespace (so `!ca` offers nothing, but `!cat sr` offers
 * `src/`). Flags (`-x`) are skipped.
 */
import { completePath } from "./file-completer"
import type { ListDir } from "./file-completer"
import type { MentionCandidate } from "../mention/types"

/**
 * Detect the trailing path token of a bash-mode line. Returns the token (without
 * any sigil) and its start column, or null when the cursor is not on a
 * completable argument (no leading `!`, on the command name, on a flag, or on an
 * empty token right after a space — so completion only fires once a prefix is
 * typed, never auto-listing the whole directory after every space).
 */
export function activeBashPathToken(beforeCursor: string): { token: string; start: number } | null {
  if (!beforeCursor.startsWith("!")) return null
  // A trailing non-space run that is PRECEDED by whitespace — so the command name
  // (the first token after `!`) is never treated as a path.
  const m = /\s(\S+)$/.exec(beforeCursor)
  if (!m) return null
  const token = m[1]
  if (token.startsWith("-")) return null // a flag, not a path
  return { token, start: beforeCursor.length - token.length }
}

/** Path completions for a bash argument token, as insertable mention candidates
 * (bare paths, no `@` sigil). */
export function completeBashPath(token: string, listDir: ListDir): MentionCandidate[] {
  return completePath(token, listDir, "").map((path) => ({
    kind: "file" as const,
    id: path,
    label: path,
    insert: path,
  }))
}
