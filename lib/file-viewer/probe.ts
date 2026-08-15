/**
 * The largest file the viewer will render.
 *
 * Enforced by the host, never by the Rust side: `fs_read_workspace_file`
 * deliberately has no default cap (pinned by
 * `read_workspace_file_never_silently_truncates_an_editor_read`), and its
 * truncation appends a marker rather than failing. A viewer that leaned on
 * that would show a file silently missing its tail.
 */
export const MAX_VIEWER_BYTES = 2 * 1024 * 1024

/** Lower-cased extension without the dot; `""` when the name has none. */
export function extensionOf(relPath: string): string {
  const name = relPath.split("/").at(-1) ?? ""
  const dot = name.lastIndexOf(".")
  // `> 0`, not `>= 0`: a dotfile like `.gitignore` is a name, not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** Exact UTF-8 byte length. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Whether `text` would exceed `limit` bytes once encoded, skipping the encode
 * where two cheap bounds already decide it.
 *
 * A UTF-8 encoding is never shorter than `text.length` (every code unit costs
 * at least one byte) and never longer than three times it — a BMP character is
 * one unit and at most three bytes, and a surrogate pair is two units and four,
 * so three bytes per unit is the ceiling either way. Only a string inside that
 * band pays for the encode, which matters when the thing being checked is a
 * 2 MiB payload on the render path.
 */
export function exceedsUtf8Limit(text: string, limit = MAX_VIEWER_BYTES): boolean {
  if (text.length > limit) return true
  if (text.length * 3 <= limit) return false
  return utf8ByteLength(text) > limit
}

/**
 * Coarse size band for diagnostics.
 *
 * A byte count is a weak content fingerprint, so the logs get a bucket instead
 * — enough to tell "the big ones are failing" from "everything is failing".
 */
export function sizeBucket(bytes: number): string {
  if (bytes <= 0) return "0"
  if (bytes < 1_024) return "<1k"
  if (bytes < 10_240) return "<10k"
  if (bytes < 102_400) return "<100k"
  if (bytes < 1_048_576) return "<1m"
  if (bytes <= MAX_VIEWER_BYTES) return "<2m"
  return ">2m"
}
