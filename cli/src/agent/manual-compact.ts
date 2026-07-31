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
 * wire shape stays single-sourced) — or after a timeout, so a provider that
 * never emits a boundary can't hang the UI. Pure + fully injected for tests.
 */
import { compactBoundaryFromInner, type CaptureStreamEvent } from "@/lib/claude/run-and-capture"

/** Raw sidecar event envelope this runner cares about (a superset is forwarded). */
interface SidecarEnvelope {
  type?: string
  sessionId?: string
  event?: unknown
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
    timeoutMs = 30_000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  } = deps

  onNotice(focus ? `Compacting context (focus: ${focus})…` : "Compacting context…")

  return new Promise<void>((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: unknown = null

    const finish = () => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimer(timer)
      if (unsubscribe) unsubscribe()
      resolve()
    }

    unsubscribe = subscribe((payload) => {
      const env = payload as SidecarEnvelope | null
      if (!env || env.type !== "event" || env.sessionId !== sessionId) return
      const boundary = compactBoundaryFromInner(env.event)
      if (!boundary) return
      emit(boundary)
      finish()
    })

    timer = setTimer(() => {
      onNotice("Compaction requested — it will apply before the next turn.")
      finish()
    }, timeoutMs)

    // Send the control message synchronously (so callers/tests see the call
    // immediately), but handle both a synchronous throw and an async rejection.
    const onSendError = (err: unknown) => {
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
