/**
 * Between-turn manual compaction for the CLI (`/compact`).
 *
 * Unlike a normal turn (driven by `runAndCaptureAssistantReply`), a manual
 * compaction is a fire-and-forget CONTROL message — the sidecar host's
 * `handleCompact` routes it to the live session's `requestCompact`, which works
 * on BOTH dispatch paths: the generic AI-SDK session summarizes older turns now,
 * and the Anthropic Agent SDK pushes a `/compact` turn it intercepts. Either way
 * the sidecar emits a `compact_boundary` system event on the normal
 * `claude://message` channel.
 *
 * Because the CLI's per-turn capture loop is NOT active between turns, this
 * runner subscribes to that channel itself, sends the control message, and
 * resolves when the boundary arrives (re-using `compactBoundaryFromInner` so the
 * wire shape stays single-sourced), when the sidecar reports that no boundary
 * will follow (see {@link manualCompactOutcomeFromInner}), or after a timeout,
 * so a provider that never answers can't hang the UI. Pure + fully injected
 * for tests.
 */
import { compactBoundaryFromInner, type CaptureStreamEvent } from "@/lib/claude/run-and-capture"

/** Raw sidecar event envelope this runner cares about (a superset is forwarded). */
interface SidecarEnvelope {
  type?: string
  sessionId?: string
  event?: unknown
}

/**
 * Why a manual compaction ended without a boundary (mirrors the sidecar).
 * `failed`: the summary produced nothing, so the history is unchanged and no
 * later attempt is queued.
 */
export type ManualCompactOutcome =
  "nothing_to_compact" | "skipped_by_plugin" | "deferred" | "failed"

const OUTCOMES: ReadonlySet<unknown> = new Set<ManualCompactOutcome>([
  "nothing_to_compact",
  "skipped_by_plugin",
  "deferred",
  "failed",
])

const OUTCOME_FALLBACK: Readonly<Record<ManualCompactOutcome, string>> = {
  nothing_to_compact: "Nothing to compact yet: the conversation is still short.",
  skipped_by_plugin: "Compaction skipped: a plugin's PreCompact hook declined it.",
  deferred: "A turn is running; compaction will apply before the next turn.",
  failed: "Compaction failed: the summary model returned no text. Nothing was compacted.",
}

/**
 * Read the sidecar's `informational` system event that reports a manual
 * compaction's outcome when no `compact_boundary` follows, or `null`.
 */
export function manualCompactOutcomeFromInner(
  inner: unknown
): { outcome: ManualCompactOutcome; message: string } | null {
  const ev = inner as {
    type?: unknown
    subtype?: unknown
    content?: unknown
    compact_outcome?: unknown
  } | null
  if (!ev || ev.type !== "system" || ev.subtype !== "informational") return null
  const outcome = ev.compact_outcome
  if (!OUTCOMES.has(outcome)) return null
  const content = typeof ev.content === "string" ? ev.content.trim() : ""
  const known = outcome as ManualCompactOutcome
  return { outcome: known, message: content || OUTCOME_FALLBACK[known] }
}

export interface RunManualCompactDeps {
  /** Target session the compaction applies to. */
  sessionId: string
  /** Optional `/compact <focus>` instruction. */
  focus?: string
  /** Subscribe to the sidecar event channel; returns an unsubscribe fn. */
  subscribe: (handler: (payload: unknown) => void) => () => void
  /** Send the `claude_compact` control message (e.g. `compactSession`). */
  compact: (sessionId: string, focus?: string) => Promise<void>
  /** Route the typed boundary event to the UI (caller maps → reducer actions). */
  emit: (event: Extract<CaptureStreamEvent, { type: "compact" }>) => void
  /** Surface a transient status line (start / timeout / error). */
  onNotice: (message: string) => void
  /** Stop waiting when the owning session is closed or replaced. */
  signal?: AbortSignal
  /** How long to wait for the boundary before giving up. Default 30s. */
  timeoutMs?: number
  /** Injectable timers (tests pass fakes; defaults to global timers). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Drive one manual compaction. Resolves when the boundary is observed, the
 * timeout elapses, or sending the control message fails. Never rejects.
 */
export function runManualCompact(deps: RunManualCompactDeps): Promise<void> {
  const {
    sessionId,
    focus,
    subscribe,
    compact,
    emit,
    onNotice,
    signal,
    timeoutMs = 30_000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  } = deps

  if (signal?.aborted) return Promise.resolve()
  onNotice(focus ? `Compacting context (focus: ${focus})…` : "Compacting context…")

  return new Promise<void>((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: unknown = null

    const finish = () => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", finish)
      if (timer !== null) clearTimer(timer)
      if (unsubscribe) unsubscribe()
      resolve()
    }

    signal?.addEventListener("abort", finish, { once: true })
    unsubscribe = subscribe((payload) => {
      if (settled) return
      const env = payload as SidecarEnvelope | null
      if (!env || env.type !== "event" || env.sessionId !== sessionId) return
      const boundary = compactBoundaryFromInner(env.event)
      if (boundary) {
        emit(boundary)
        finish()
        return
      }
      // No boundary is coming: the sidecar says why (nothing old enough to
      // fold, a plugin declined, a running turn defers it, or the summary
      // failed).
      const outcome = manualCompactOutcomeFromInner(env.event)
      if (!outcome) return
      onNotice(outcome.message)
      finish()
    })
    // An injected/event-replaying subscriber may settle synchronously.
    if (settled) {
      unsubscribe()
      return
    }

    // Silence means neither a boundary nor an outcome arrived in time — not
    // that one is queued. Only a running turn defers a compaction, and the
    // sidecar says so itself, so the timeout must not promise a later apply.
    timer = setTimer(() => {
      onNotice(
        `Compaction has not finished after ${Math.round(timeoutMs / 1000)}s — nothing has been compacted yet. Run /compact again if the context meter does not drop.`
      )
      finish()
    }, timeoutMs)

    // Send the control message synchronously (so callers/tests see the call
    // immediately), but handle both a synchronous throw and an async rejection.
    const onSendError = (err: unknown) => {
      if (settled) return
      onNotice(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`)
      finish()
    }
    try {
      Promise.resolve(compact(sessionId, focus)).catch(onSendError)
    } catch (err) {
      onSendError(err)
    }
  })
}
