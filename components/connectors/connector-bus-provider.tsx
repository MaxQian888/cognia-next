"use client"

/**
 * ConnectorBusProvider — Task 41 + im-refactored-crayon.
 *
 * Thin React host for the shared connector bootstrap. The whole boot
 * sequence (scheduler executors → WS reap → adapter boot loop → runtime
 * route handler behind the PII gate → outbound runner → sweeps) lives in
 * `lib/connectors/bootstrap/install-connector-runtime.ts` so the headless
 * brain can run the identical code (ADR-0059 T-A5); this component only
 * binds it to the React lifecycle.
 *
 * No-op in web mode (the installer's default host gate is `isTauri()`).
 *
 * Deferred while driving a REMOTE Cognia host: when `isRemoteHostActive()`
 * (ADR-0082) the paired host's brain owns the connector runtime, so booting a
 * second copy here would double-dial the same bots — duplicate inbound events
 * AND duplicate outbound replies on the same account. We tear the local
 * runtime down when a remote host is activated and reclaim it when routing
 * returns to local. (`installConnectorRuntime`'s own Web Locks guard only
 * coordinates this desktop's webviews; it cannot see the remote process.)
 *
 * Losing the runtime LEASE is a third case (ADR-0131 §2.7), distinct from both
 * of the above: another process — typically a headless brain starting up —
 * claimed the lease while this desktop was running, so the installer tore
 * itself down on its own. Nothing in the React lifecycle fires for that, and
 * the transport subscription does not either (routing is still local), so
 * before this the desktop simply sat there with no runtime until the user
 * restarted the app. Now it retries on a bounded backoff and takes the runtime
 * back as soon as the peer releases it; the reclaimed runtime's own
 * `resumeDurableInboundJobs({ reclaimRunning: true })` picks up whatever was
 * in flight.
 */

import { useEffect } from "react"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

/**
 * Backoff between re-acquisition attempts after a lost lease, in ms. Starts
 * fast enough to win back a lease the peer only borrowed for a moment, and
 * settles at five minutes so a genuinely brain-owned deployment is not
 * hammered — the retry is a race for a shared resource, and losing it
 * repeatedly is the expected steady state there.
 */
export const RUNTIME_RECLAIM_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const

export interface ConnectorBusProviderProps {
  children?: React.ReactNode
  /** Test seam for the bootstrap (default: the real installer). */
  install?: typeof installConnectorRuntime
  /** Test seam for the timer (default: `setTimeout`). */
  scheduleRetry?: (run: () => void, delayMs: number) => () => void
}

const defaultScheduleRetry = (run: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(run, delayMs)
  return () => clearTimeout(handle)
}

export function ConnectorBusProvider({
  children,
  install = installConnectorRuntime,
  scheduleRetry = defaultScheduleRetry,
}: ConnectorBusProviderProps) {
  useEffect(() => {
    let dispose: (() => void) | undefined
    let cancelRetry: (() => void) | undefined
    let attempt = 0
    let unmounted = false

    const clearRetry = () => {
      cancelRetry?.()
      cancelRetry = undefined
    }

    /**
     * The installer released the runtime because a peer took the lease. Arm a
     * backoff and try again — but only while routing is still local, since an
     * activated remote host means we are *meant* to have no runtime.
     */
    const onRuntimeReleased = () => {
      if (unmounted) return
      dispose = undefined
      clearRetry()
      const delay =
        RUNTIME_RECLAIM_BACKOFF_MS[Math.min(attempt, RUNTIME_RECLAIM_BACKOFF_MS.length - 1)]
      attempt += 1
      cancelRetry = scheduleRetry(() => {
        cancelRetry = undefined
        if (unmounted || isRemoteHostActive()) return
        boot()
      }, delay)
    }

    const boot = () => {
      // `installConnectorRuntime` is safe to call when another context already
      // owns the lock — it simply does not boot a second runtime.
      dispose ??= install({ onRuntimeReleased })
    }

    // Own the local runtime only while routing locally; defer to the remote
    // brain otherwise. Re-evaluated on every active-host switch.
    const sync = () => {
      if (isRemoteHostActive()) {
        clearRetry()
        dispose?.()
        dispose = undefined
      } else {
        // Routing came back to local — start the backoff ladder fresh so a
        // later lease loss retries promptly rather than at five minutes.
        attempt = 0
        boot()
      }
    }
    sync()
    const unsubscribe = subscribeActiveRemoteTransport(sync)
    return () => {
      unmounted = true
      unsubscribe()
      clearRetry()
      dispose?.()
    }
  }, [install, scheduleRetry])

  return <>{children}</>
}
