"use client"

/**
 * Bounded, redacted trail of the sidecar's own error output.
 *
 * # Why the frames were dropped, and why that was wrong
 *
 * `log` frames used to be discarded outright (`case "log": return`). That was
 * the right call for the obvious alternative — rendering them — because a log
 * line is not a turn outcome: a warning mid-stream would have surfaced as a
 * failure on a turn that went on to succeed, and the terminal state belongs to
 * the lifecycle events, not to whatever the process happened to print.
 *
 * But dropping them threw away the only thing that ever says *why* the sidecar
 * died. `sidecarExited` is raised with no message, so a crash reads as "the
 * backend stopped" and the stderr line that explains it is gone.
 *
 * This keeps that line and nothing else: the last few error-level entries, each
 * redacted and truncated, read only when something terminal has already
 * happened. It is never a surface of its own.
 *
 * # Bounds
 *
 * Fixed capacity and a per-entry length cap, both enforced on write. A sidecar
 * in a crash loop can print without limit, and this buffer lives for the life
 * of the renderer.
 */

import { redactText } from "@cognia/redact"

/** How many error-level entries to keep. Enough to show a cause and its context. */
export const SIDECAR_LOG_TRAIL_CAPACITY = 20

/** Per-entry cap. A stack trace is truncated, not stored whole. */
export const SIDECAR_LOG_ENTRY_MAX_CHARS = 300

export interface SidecarLogEntry {
  /** Epoch ms, injected by the caller so tests can assert ordering. */
  at: number
  /** Redacted and truncated. Never the raw line. */
  message: string
  /** Present when the frame named a session. */
  sessionId?: string
}

/** The shape of a `log` frame, narrowed to what this module reads. */
export interface SidecarLogFrame {
  level?: string
  message?: unknown
  sessionId?: string
}

const trail: SidecarLogEntry[] = []

/**
 * True for the levels worth keeping.
 *
 * `info`/`debug` are the bulk of the volume and explain nothing about a crash,
 * so they are dropped at the door rather than stored and filtered later.
 */
function isErrorLevel(level: string | undefined): boolean {
  const normalized = (level ?? "").trim().toLowerCase()
  return normalized === "error" || normalized === "fatal" || normalized === "warn"
}

function clean(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Redact first, truncate second: truncating first could cut a credential in
  // half and leave the remaining half unmatched by the redactor's patterns.
  const { redacted } = redactText(trimmed)
  return redacted.length > SIDECAR_LOG_ENTRY_MAX_CHARS
    ? `${redacted.slice(0, SIDECAR_LOG_ENTRY_MAX_CHARS - 1)}…`
    : redacted
}

/**
 * Record one `log` frame. Non-error levels and empty messages are ignored.
 *
 * Returns the stored entry (or `null` when the frame was ignored) so a caller
 * can assert what was kept without reaching into the buffer.
 */
export function recordSidecarLog(frame: SidecarLogFrame, at: number): SidecarLogEntry | null {
  if (!isErrorLevel(frame.level)) return null
  const message = clean(frame.message)
  if (!message) return null
  const entry: SidecarLogEntry = {
    at,
    message,
    ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
  }
  trail.push(entry)
  while (trail.length > SIDECAR_LOG_TRAIL_CAPACITY) trail.shift()
  return entry
}

/**
 * How recent a line has to be to be offered as the cause of an exit.
 *
 * The trail is capacity-bounded, not time-bounded, so without this a `warn`
 * printed at minute 1 of a long session was still the newest entry an hour
 * later and got attached to an unrelated crash as its explanation. A line that
 * did not precede the exit by seconds did not explain it; saying nothing is the
 * honest answer, and `sidecarExited` reads fine without supporting text.
 */
export const SIDECAR_CAUSE_MAX_AGE_MS = 30_000

/**
 * The most recent error line, optionally scoped to a session, and only while it
 * is recent enough to plausibly explain what just happened
 * ({@link SIDECAR_CAUSE_MAX_AGE_MS}).
 *
 * A session-scoped read falls back to the unscoped tail: the frame that
 * explains a crash is frequently emitted by the supervisor, after the session
 * context is already gone. The age bound is what keeps that fallback from
 * handing one session's stale warning to another's exit.
 */
export function lastSidecarError(
  sessionId?: string,
  now: number = Date.now()
): SidecarLogEntry | undefined {
  const fresh = (entry: SidecarLogEntry | undefined): SidecarLogEntry | undefined =>
    entry && now - entry.at <= SIDECAR_CAUSE_MAX_AGE_MS ? entry : undefined
  if (sessionId) {
    for (let i = trail.length - 1; i >= 0; i -= 1) {
      if (trail[i]!.sessionId === sessionId) return fresh(trail[i])
    }
  }
  return fresh(trail[trail.length - 1])
}

/** A copy of the trail, oldest first. */
export function readSidecarLogTrail(): readonly SidecarLogEntry[] {
  return [...trail]
}

/**
 * Drop everything. Called from the `ready` frame — a fresh sidecar means every
 * line in here belongs to a process that is gone — and by tests.
 */
export function clearSidecarLogTrail(): void {
  trail.length = 0
}
