/**
 * In-process wake bus for the `flow.wait` event mode.
 *
 * The orchestrator pauses a `flow.wait(event)` step by registering a wake key
 * with `subscribeWake(key)` and `await`-ing the returned promise. Any in-
 * process source (webhook receiver, connector inbound tap, chat-message hook,
 * plugin-emitted trigger) calls `emitWake(key, payload)` to resume.
 *
 * Wake keys are workflow- / step-scoped (`${runId}:${stepId}`) so two
 * parallel runs of the same workflow never collide. The bus is purely TS-
 * side; cross-process (Rust → TS) wakes ride the existing `workflow:trigger`
 * IPC and are translated into local emits by the trigger bridge.
 *
 * The store is intentionally simple — Map<key, oneshot resolver> — so the
 * memory cost is one entry per outstanding wait and entries clean up on
 * resolve / cancel.
 */

export interface WakePayload {
  /** Source that fired the wake (free-form string). */
  source: string
  /** Free-form payload echoed back to the awaiting step. */
  data?: unknown
  /** Wall-clock timestamp at emit. */
  emittedAt: number
}

type Resolver = (payload: WakePayload) => void

interface Pending {
  resolve: Resolver
  reject: (err: Error) => void
  timeoutHandle?: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

export interface SubscribeOptions {
  /** Auto-cancel after `timeoutMs`. Default: no timeout. */
  timeoutMs?: number
  /** External AbortSignal — when aborted, the wait rejects. */
  signal?: AbortSignal
}

/**
 * Subscribe to a wake event. Returns a Promise that resolves when
 * `emitWake(key, payload)` fires, or rejects on timeout / abort.
 */
export function subscribeWake(key: string, options: SubscribeOptions = {}): Promise<WakePayload> {
  return new Promise<WakePayload>((resolve, reject) => {
    // If a previous subscription is hanging around (shouldn't happen — we
    // delete on resolve/cancel), kick it off so the new subscriber wins.
    const previous = pending.get(key)
    if (previous) {
      previous.reject(new Error("wake bus: superseded by a new subscriber"))
      if (previous.timeoutHandle) clearTimeout(previous.timeoutHandle)
    }

    const entry: Pending = {
      resolve: (payload) => {
        if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
        pending.delete(key)
        resolve(payload)
      },
      reject: (err) => {
        if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
        pending.delete(key)
        reject(err)
      },
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      entry.timeoutHandle = setTimeout(() => {
        entry.reject(new Error(`wake bus: ${key} timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    }

    if (options.signal) {
      if (options.signal.aborted) {
        entry.reject(new Error("wake bus: aborted"))
        return
      }
      options.signal.addEventListener(
        "abort",
        () => {
          entry.reject(new Error("wake bus: aborted"))
        },
        { once: true }
      )
    }

    pending.set(key, entry)
  })
}

/**
 * Fire a wake event. Returns `true` when a subscriber was waiting on `key`.
 * `false` (the no-op case) is intentional — events that arrive before the
 * step subscribes are dropped on the floor; the step will see them on a
 * later subscribe if the source re-fires.
 */
export function emitWake(key: string, payload: Omit<WakePayload, "emittedAt">): boolean {
  const entry = pending.get(key)
  if (!entry) return false
  entry.resolve({ ...payload, emittedAt: Date.now() })
  return true
}

/**
 * Cancel a wait. Idempotent — returns `true` when something was actually
 * cancelled. Used by the orchestrator's abort path so the run failure
 * tear-down doesn't leave dangling promises.
 */
export function cancelWake(key: string, reason = "cancelled"): boolean {
  const entry = pending.get(key)
  if (!entry) return false
  entry.reject(new Error(`wake bus: ${reason}`))
  return true
}

/** Test-only — peek at the in-flight subscriptions. */
export function _peekWakeKeys(): string[] {
  return Array.from(pending.keys())
}

/** Test-only — wipe all in-flight subscriptions without rejecting them. */
export function _clearWakeBusForTest(): void {
  for (const entry of pending.values()) {
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
  }
  pending.clear()
}
