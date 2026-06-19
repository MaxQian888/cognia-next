/**
 * Shared on-disk format for the cognia CLI composer history file
 * (`~/.cognia/history.json`). Pure functions — no fs, no env — so both the
 * standalone CLI (`cli/src/tui/input/history-store.ts`) and the desktop→CLI
 * push (`lib/cli-bridge/push-history.ts`) serialize byte-for-byte the same way
 * and never drift.
 *
 * Body is newline-delimited (one entry per line). A multi-line entry survives
 * a round-trip because newlines and backslashes are escaped, so it collapses
 * to a single visual line on disk.
 */

/** Max entries kept on disk. Matches Claude Code's 100-entry composer history. */
export const HISTORY_LIMIT = 100

export const HISTORY_FILE_NAME = "history.json"

/**
 * Parse the file body into entries (oldest → newest). Blank lines are dropped;
 * a trailing newline (common) does not produce an empty entry.
 */
export function parseHistory(raw: string): string[] {
  const lines = raw.split("\n")
  const out: string[] = []
  for (const line of lines) {
    // Entries are stored with newlines escaped (see serializeHistory); a raw
    // blank line is just padding and is skipped.
    if (line.length === 0) continue
    out.push(line.replace(/\\n/g, "\n").replace(/\\\\/g, "\\"))
  }
  return out
}

/**
 * Serialize entries (oldest → newest) to the file body, escaping backslashes
 * first then newlines so a multi-line entry survives the round-trip as one
 * line. Always ends with a trailing newline.
 */
export function serializeHistory(entries: string[]): string {
  return entries.map((e) => e.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")).join("\n") + "\n"
}

/**
 * Cap a list to the newest {@link HISTORY_LIMIT} entries (entries are
 * oldest → newest, so the tail is kept).
 */
export function capHistory(entries: string[]): string[] {
  return entries.length > HISTORY_LIMIT ? entries.slice(entries.length - HISTORY_LIMIT) : entries
}
