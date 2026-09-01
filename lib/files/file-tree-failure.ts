/**
 * Why a file-tree operation failed, in a vocabulary an interface can render.
 *
 * `ProjectFileTree` swallowed all four of its failure paths. On a local
 * workspace that was survivable, because a directory the app registered is
 * almost always listable and a rename almost always lands. It stopped being
 * survivable the moment the same tree was pointed at a remote filesystem over
 * SFTP (ADR-0162), where permission denials, read-only mounts, full disks and
 * dropped connections are the ordinary case rather than the exception.
 *
 * The worst of the four was the listing path, which wrote an empty array on
 * failure. "You may not read this directory" and "this directory is empty"
 * render identically, and the second one is a lie the user acts on.
 *
 * This module is the classifier alone. It throws nothing, renders nothing and
 * knows about no transport, so a workspace backend and an SFTP backend can
 * share one vocabulary and one set of strings.
 */

/**
 * The distinctions worth drawing, chosen by what the reader would do next.
 *
 * - `denied`      the credentials are fine and the permission is not. Asking
 *                 again will not help. Fix it on the far side.
 * - `missing`     the path is gone. Refresh, or it was deleted underneath you.
 * - `conflict`    something is already there, or the directory is not empty.
 * - `capacity`    no space, or a quota. Free something and retry.
 * - `refused`     the Host declined the call outright and said it will not
 *                 work however many times you ask (`retryable: false`).
 * - `unreachable` nobody answered. This is the one worth retrying.
 */
export type FileTreeFailureKind =
  "denied" | "missing" | "conflict" | "capacity" | "refused" | "unreachable"

/** The operation that failed, so a message can name what was being attempted. */
export type FileTreeOperation = "list" | "create" | "rename" | "delete" | "read" | "write"

export interface FileTreeFailure {
  kind: FileTreeFailureKind
  /** The far side's own words, when it gave any. Never invented. */
  detail: string | null
  /** A machine-readable refusal code, when the Host supplied one. */
  code: string | null
}

/**
 * Signals, most specific first.
 *
 * Matched against the message text because that is what actually crosses the
 * boundary. A POSIX `errno` from an SFTP server, a Rust `io::Error` display
 * string and a Node `EACCES` have all been flattened to a sentence by the time
 * they reach a renderer. Codes are checked before text so a Host that
 * classifies properly is never second-guessed by a substring.
 */
const TEXT_SIGNALS: readonly (readonly [FileTreeFailureKind, RegExp])[] = [
  [
    "denied",
    /\b(eacces|eperm|erofs)\b|permission denied|access is denied|read-?only file system|not permitted/i,
  ],
  ["missing", /\b(enoent|enotdir)\b|no such file|does not exist|not found/i],
  ["conflict", /\b(eexist|enotempty|ebusy)\b|already exists|directory not empty|in use/i],
  ["capacity", /\b(enospc|edquot|efbig)\b|no space left|quota exceeded|file too large|disk full/i],
]

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return ""
}

/**
 * Classify a thrown error.
 *
 * Never throws and never returns null. An unrecognised failure is
 * `unreachable`, which is the honest default: it is the only kind that invites
 * a retry, and inviting a retry on something unknown beats asserting a cause
 * the error never stated.
 */
export function classifyFileTreeFailure(error: unknown): FileTreeFailure {
  const message = messageOf(error).trim()
  const detail = message.length > 0 ? message : null

  // A companion refusal is shape-checked rather than `instanceof`-checked: the
  // error crosses a module boundary, and every companion error carries `code`
  // plus `retryable`. This mirrors how `workspace-folder-picker` already reads
  // the same shape.
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; retryable?: unknown }
    const code = typeof candidate.code === "string" ? candidate.code : null
    if (code && candidate.retryable === false) {
      // A refusal can still be a permission problem, and the specific answer is
      // more useful than the generic one when the code itself says so.
      //
      // `forbidden` is deliberately NOT a signal here. It is the word the
      // transport layer uses for its own refusals (`command_transport_forbidden`
      // is "this command may not ride this socket"), and reading that as a file
      // permission would send the reader to check the file's mode when the call
      // never reached a filesystem at all. A genuine permission code says
      // `denied`, `permission` or `unauthorized`.
      if (/denied|unauthori[sz]ed|permission/i.test(code)) {
        return { kind: "denied", detail, code }
      }
      return { kind: "refused", detail, code }
    }
    if (code) {
      for (const [kind, pattern] of TEXT_SIGNALS) {
        if (pattern.test(code)) return { kind, detail, code }
      }
    }
  }

  for (const [kind, pattern] of TEXT_SIGNALS) {
    if (pattern.test(message)) return { kind, detail, code: null }
  }
  return { kind: "unreachable", detail, code: null }
}

/**
 * Whether asking again could plausibly succeed without the user changing
 * something first.
 *
 * Used to decide whether a surface offers a retry affordance. Offering one on a
 * permission denial trains people to click it, which is how a real cause gets
 * mistaken for a flaky connection.
 */
export function isFileTreeFailureRetryable(failure: FileTreeFailure): boolean {
  return failure.kind === "unreachable"
}
