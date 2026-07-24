/**
 * One owner for an external backend's whole life: connect attempt, spawned
 * process, protocol session, tool-host broker, cancellation, retry and disposal.
 *
 * The connect used to be a React effect with a local `cancelled` flag. That flag
 * makes a LATE result *ignored*, which is not the same as *cleaned up*: a
 * process that finishes registering after the one-shot disconnect has already
 * run stays registered, and nothing else ever removes it. Two rapid `/backend`
 * switches could therefore leave a live agent behind with no handle to it.
 *
 * The fix is to make cancellation authoritative rather than advisory. Attempts
 * are numbered; a result belonging to a superseded attempt is not just dropped,
 * it is disconnected. Every exit path — cancel, switch, unmount, double-dispose
 * — funnels through the same teardown, in the order the tool host requires:
 *
 *   stop accepting tool calls → reject pending broker calls → cancel the
 *   external turn → close the protocol session → disconnect the bridge →
 *   remove the agent
 *
 * The first four steps belong to the session (it owns the broker and the turn),
 * so the controller runs `closeSession` before `disconnect`. Getting that order
 * wrong lets a bridge execute a tool against a session that is already gone.
 */

export interface LifecycleConnection {
  agentId: string
}

export interface BackendLifecycleDeps<C extends LifecycleConnection> {
  /** Start a connect for `attempt`. Resolves with the connection, or null on
   * failure (the caller reports the failure itself). */
  connect: (attempt: number) => Promise<C | null>
  /** Reclaim a connection's process. Must be idempotent and never throw. */
  disconnect: (connection: C) => Promise<void>
  /**
   * Close the agent SESSION bound to this connection, before the process is
   * reclaimed. Optional: a controller that owns no session skips it.
   */
  closeSession?: () => Promise<void>
}

export interface BackendLifecycle<C extends LifecycleConnection> {
  /** The attempt currently allowed to install its result. */
  readonly attempt: number
  /** The live connection, or null. */
  current(): C | null
  /**
   * Run one connect. Resolves with the connection when it is still current, or
   * null when the attempt was superseded/cancelled — in which case the late
   * result has already been disconnected rather than merely ignored.
   */
  start(): Promise<C | null>
  /** Supersede the in-flight attempt. A late result will be reclaimed. */
  cancel(): void
  /** Full teardown: close the session, reclaim the process, refuse new starts. */
  dispose(): Promise<void>
  /** True once `dispose` ran. */
  isDisposed(): boolean
}

export function createBackendLifecycle<C extends LifecycleConnection>(
  deps: BackendLifecycleDeps<C>
): BackendLifecycle<C> {
  let attempt = 0
  let connection: C | null = null
  let disposed = false
  // Serializes teardown against an in-flight start, so `dispose` cannot return
  // before a connect that is still settling has been reclaimed.
  let inflight: Promise<unknown> | null = null

  /** Reclaim a connection that must not stay registered. Never throws. */
  const reclaim = async (target: C): Promise<void> => {
    try {
      await deps.disconnect(target)
    } catch {
      // Teardown is best-effort by contract; a throw here would strand the
      // caller mid-cleanup with nothing better to do about it.
    }
  }

  return {
    get attempt() {
      return attempt
    },
    current: () => connection,
    isDisposed: () => disposed,
    cancel() {
      // Bumping the attempt is what makes cancellation authoritative: the
      // settling connect below sees a mismatch and reclaims its own result.
      attempt += 1
      const previous = connection
      connection = null
      if (previous) void reclaim(previous)
    },
    async start() {
      if (disposed) return null
      attempt += 1
      const mine = attempt
      // A new attempt supersedes the previous connection — reclaim it rather
      // than leaking it behind the new one.
      const previous = connection
      connection = null
      if (previous) await reclaim(previous)
      const run = deps.connect(mine).then(
        (result) => result,
        () => null
      )
      inflight = run
      const result = await run
      if (inflight === run) inflight = null
      if (!result) return null
      // The late-registration race: this attempt was cancelled (or disposed)
      // while the process was still coming up. Ignoring the result would leave
      // that process registered forever, so remove it.
      if (disposed || mine !== attempt) {
        await reclaim(result)
        return null
      }
      connection = result
      return result
    },
    async dispose() {
      if (disposed) return
      disposed = true
      // Stop accepting work first: the session owns the tool-host broker, so
      // closing it rejects pending tool calls and cancels the turn BEFORE the
      // process it was talking to disappears.
      if (deps.closeSession) {
        try {
          await deps.closeSession()
        } catch {
          // best-effort — the process reclaim below is the authoritative half
        }
      }
      // Wait out a connect that is still settling, so its result cannot be
      // registered after we have finished tearing down.
      if (inflight) {
        try {
          await inflight
        } catch {
          // handled by `start`
        }
      }
      const target = connection
      connection = null
      if (target) await reclaim(target)
    },
  }
}
