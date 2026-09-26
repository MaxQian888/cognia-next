// Failure taxonomy for built-in tool results.
//
// A tool failure used to be one boolean — `isError: true` — plus whatever
// prose the throw site happened to produce. From the model's side "your disk
// is full", "you passed the wrong argument", "the user said no" and "the
// backend is down" were the same event, so it did the only thing it could:
// call the tool again. Retry loops on a full disk are not a model problem,
// they are a missing-signal problem.
//
// Two things are added here, and only these two:
//
//   1. a CLOSED set of failure kinds, so every failure says what KIND it was;
//   2. explicit retry guidance, so the model never has to infer retryability
//      from prose.
//
// The kinds line up with `InvokePluginToolErrorCode`
// (`lib/plugin/core/invoke-plugin-tool.ts`) wherever the two overlap, so the
// plugin path and the built-in path classify the same thing the same way.
//
// Pure: no I/O, no imports. Mirrored nowhere — this is the single definition.

/**
 * Every failure a built-in tool can report. Closed on purpose: a new kind is
 * a deliberate edit here, not an ad-hoc string at a throw site.
 */
export type ToolFailureKind =
  | "invalid-args"
  | "not-found"
  | "permission-denied"
  | "timeout"
  | "aborted"
  | "user-rejected"
  | "resource-exhausted"
  | "environment"
  | "backend-unavailable"
  | "execution-failed"

export interface ToolFailurePolicy {
  retryable: boolean
  guidance: string
}

/** One classified failure: its kind, retry policy, and the thrown message. */
export interface ToolFailure extends ToolFailurePolicy {
  kind: ToolFailureKind
  message: string
}

export const TOOL_FAILURE_KINDS: readonly ToolFailureKind[] = Object.freeze([
  "invalid-args",
  "not-found",
  "permission-denied",
  "timeout",
  "aborted",
  "user-rejected",
  "resource-exhausted",
  "environment",
  "backend-unavailable",
  "execution-failed",
])

/**
 * Whether calling the tool again with the SAME input could plausibly succeed,
 * and the sentence the model is told.
 *
 * `retryable: false` is the load-bearing half. It is set only where a repeat
 * of the identical call cannot help — not merely where it is unlikely to.
 */
export const TOOL_FAILURE_POLICY: Readonly<Record<ToolFailureKind, ToolFailurePolicy>> =
  Object.freeze({
    "invalid-args": {
      retryable: false,
      guidance: "Do not repeat this call unchanged — fix the arguments first.",
    },
    "not-found": {
      retryable: false,
      guidance:
        "Do not repeat this call unchanged — the target does not exist. Locate it first, or work from what does exist.",
    },
    "permission-denied": {
      retryable: false,
      guidance:
        "Do not retry and do not look for a way around it. Only the user can grant this; continue with the rest of the task and say what you could not do.",
    },
    timeout: {
      retryable: true,
      guidance:
        "Retrying may work, but narrow the request first — the same scope will likely time out again.",
    },
    aborted: {
      retryable: false,
      guidance: "The call was cancelled. Do not restart it on your own.",
    },
    "user-rejected": {
      retryable: false,
      guidance:
        "The user declined this. Do not ask again for the same action and do not route around it; continue with the rest of the task.",
    },
    "resource-exhausted": {
      retryable: false,
      guidance:
        "This is a machine limit, not a mistake in your call — retrying will fail the same way. Tell the user what ran out.",
    },
    environment: {
      retryable: false,
      guidance:
        "The environment is missing something this tool needs. Retrying will not install it; report what is missing.",
    },
    "backend-unavailable": {
      retryable: true,
      guidance: "The backend is unreachable. One retry is reasonable; a second is not.",
    },
    "execution-failed": {
      retryable: true,
      guidance: "Read the error before deciding whether repeating the call could help.",
    },
  })

/** errno → kind. Covers the ones that are routinely misread as tool bugs. */
const ERRNO_KINDS: Readonly<Record<string, ToolFailureKind>> = Object.freeze({
  ENOENT: "not-found",
  ENOTDIR: "not-found",
  EISDIR: "invalid-args",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EROFS: "permission-denied",
  ENOSPC: "resource-exhausted",
  EMFILE: "resource-exhausted",
  ENFILE: "resource-exhausted",
  EDQUOT: "resource-exhausted",
  ETIMEDOUT: "timeout",
  ECONNREFUSED: "backend-unavailable",
  ECONNRESET: "backend-unavailable",
  EHOSTUNREACH: "backend-unavailable",
  ENETUNREACH: "backend-unavailable",
  ENOTFOUND: "backend-unavailable",
  ENOEXEC: "environment",
})

/** Message shapes that carry a kind when no errno does. Order matters. */
const MESSAGE_KINDS: readonly (readonly [RegExp, ToolFailureKind])[] = Object.freeze([
  [/\b(aborted|abortarror|abort ?error|cancell?ed)\b/i, "aborted"],
  // Deliberately narrow: a bare "denied" is almost always the OS refusing,
  // not the human. Only an explicit reference to the user lands here.
  [
    /\buser (declined|refused|rejected|said no)\b|\b(declined|rejected|denied) by the user\b/i,
    "user-rejected",
  ],
  [/\bpermission denied\b|\bnot permitted\b|\bforbidden\b|\baccess denied\b/i, "permission-denied"],
  [/\btimed? ?out\b|\bdeadline exceeded\b|\bexecution budget\b/i, "timeout"],
  [/\bcommand not found\b|\bis not recognized\b|\bunsupported platform\b/i, "environment"],
  [/\bno such file\b|\bnot found\b|\bdoes not exist\b/i, "not-found"],
  [/\binvalid\b|\bmalformed\b|\bexpected .* but\b|\brequired\b/i, "invalid-args"],
  [/\bno space left\b|\bout of memory\b|\btoo many open files\b/i, "resource-exhausted"],
  [/\bECONN|\bunreachable\b|\bconnection refused\b/i, "backend-unavailable"],
])

/** Pull a `code`/`errno` string off an unknown thrown value. */
function errnoOf(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined
  const { code, cause } = err as { code?: unknown; cause?: unknown }
  if (typeof code === "string" && code) return code
  return cause ? errnoOf(cause) : undefined
}

/** Human-readable message for an unknown thrown value, stack stripped. */
export function failureMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return String(err)
}

/**
 * Classify a thrown value into a kind and its retry policy.
 *
 * `kindHint` wins when the caller already knows (a timeout wrapper, a
 * permission gate); otherwise errno wins over message shape, because errno is
 * fact and a message is prose. An unknown `kind` hint is ignored.
 */
export function classifyToolFailure(err: unknown, opts: { kind?: unknown } = {}): ToolFailure {
  const message = failureMessage(err)
  let kind: ToolFailureKind | undefined = TOOL_FAILURE_KINDS.find((known) => known === opts.kind)

  if (!kind) {
    const errno = errnoOf(err)
    if (errno && ERRNO_KINDS[errno]) kind = ERRNO_KINDS[errno]
  }
  if (
    !kind &&
    err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  ) {
    kind = "aborted"
  }
  if (!kind) {
    for (const [pattern, candidate] of MESSAGE_KINDS) {
      if (pattern.test(message)) {
        kind = candidate
        break
      }
    }
  }
  if (!kind) kind = "execution-failed"

  const policy = TOOL_FAILURE_POLICY[kind]
  return { kind, retryable: policy.retryable, guidance: policy.guidance, message }
}

/**
 * The text the MODEL sees: what failed, what kind of failure it was, and
 * whether repeating the call could help.
 */
export function renderFailureForModel(
  failure: Pick<ToolFailure, "kind" | "guidance" | "message">,
  contextLabel?: string
): string {
  const head = contextLabel ? `${contextLabel}: ${failure.message}` : failure.message
  return `${head}\n[${failure.kind}] ${failure.guidance}`
}
