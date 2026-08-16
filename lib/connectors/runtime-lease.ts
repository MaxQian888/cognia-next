/**
 * Single-owner guard for the connector runtime, shared by both hosts.
 *
 * The runtime assumes exactly one owner per account: two copies double-dial
 * the same bots, so every inbound message is handled twice and every reply is
 * sent twice. Three things can each run one, and they need different guards:
 *
 *   - two webviews of one desktop app  → Web Locks (origin-scoped, in
 *     `install-connector-runtime.ts`);
 *   - two brain processes on one companion → this lease;
 *   - the desktop webview vs. a brain attached to that desktop's companion
 *     → also this lease, which is why the desktop takes it too.
 *
 * The lease lives in Rust (`ConnectorsState`), reachable over Tauri IPC on the
 * desktop and over the companion RPC arms from a brain — one slot either way,
 * because both bind the same managed state.
 *
 * Owner ids carry their class as a prefix. An always-on `brain:` owner reserves
 * a handoff from a `desktop:` one; it starts only after the desktop observes
 * lease loss and releases (or its lease expires). The reverse is refused. A
 * laptop that booted first must not keep the bots off the process that is
 * actually up all day, and a desktop must not evict a running brain.
 */

export const CONNECTOR_RUNTIME_LEASE_TTL_MS = 15_000
export const CONNECTOR_RUNTIME_LEASE_RENEW_MS = 5_000
export const CONNECTOR_RUNTIME_HANDOFF_POLL_MS = 100

export type RuntimeLeaseLog = (level: "info" | "warn" | "error", message: string) => void

/** The three lease arms, however this host reaches them. */
export type RuntimeLeaseAcquireResult = "acquired" | "busy" | "handoff-pending"

export interface RuntimeLeasePorts {
  /** Boolean is retained for custom/legacy ports; host ports use the outcome. */
  acquire: (ownerId: string, ttlMs: number) => Promise<RuntimeLeaseAcquireResult | boolean>
  renew: (ownerId: string, ttlMs: number) => Promise<boolean>
  release: (ownerId: string) => Promise<boolean>
}

export interface ConnectorRuntimeLeaseOptions {
  /** Priority class; also the owner-id prefix the Rust side reads. */
  ownerClass: "brain" | "desktop"
  /** Reaches the lease arms — Tauri IPC (desktop) or companion RPC (brain). */
  ports: RuntimeLeasePorts
  log: RuntimeLeaseLog
  /** The lease was lost (preempted or expired) — tear the runtime down. */
  onLeaseLost: () => void | Promise<void>
  /** The lease was just taken — (re)install owner-only subscriptions. */
  onLeaseAcquired?: () => void
  /**
   * What to do when the lease itself is unreachable.
   *
   * `"block"` (brain): a brain that cannot reach its companion has no business
   * booting — it would be an unarbitrated second owner by definition.
   *
   * `"proceed"` (desktop): the companion API server is optional on the
   * desktop, and a stock install with it switched off must keep working
   * exactly as it did before this guard existed. The Web Locks guard still
   * covers the multi-webview case; only cross-process arbitration is lost.
   */
  onUnavailable: "block" | "proceed"
  /** Test seam. */
  makeOwnerId?: () => string
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  /** Test seam for the short handoff poll. */
  waitForHandoff?: (delayMs: number) => Promise<void>
}

function normalizeAcquireResult(
  result: RuntimeLeaseAcquireResult | boolean
): RuntimeLeaseAcquireResult {
  if (result === true) return "acquired"
  if (result === false) return "busy"
  return result
}

/**
 * Build the `acquireRuntimeLock` callback `installConnectorRuntime` expects:
 * resolves `true` when THIS caller owns the runtime, and holds/renews the
 * lease until `signal` aborts.
 */
export function createConnectorRuntimeLease(
  opts: ConnectorRuntimeLeaseOptions
): (signal: AbortSignal) => Promise<boolean> {
  const setTimer = opts.setInterval ?? setInterval
  const clearTimer = opts.clearInterval ?? clearInterval
  const waitForHandoff =
    opts.waitForHandoff ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const ownerId = `${opts.ownerClass}:${opts.makeOwnerId?.() ?? crypto.randomUUID()}`

  return async (signal) => {
    if (signal.aborted) return false

    let outcome: RuntimeLeaseAcquireResult
    try {
      outcome = normalizeAcquireResult(
        await opts.ports.acquire(ownerId, CONNECTOR_RUNTIME_LEASE_TTL_MS)
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (opts.onUnavailable === "proceed") {
        opts.log(
          "warn",
          `[connector-bus] Runtime lease unavailable (${reason}); continuing without cross-process arbitration`
        )
        return true
      }
      opts.log("error", `[connector-bus] Runtime lease acquisition failed: ${reason}`)
      return false
    }

    let handoffReserved = false
    while (outcome === "handoff-pending") {
      handoffReserved = true
      if (signal.aborted) {
        await opts.ports.release(ownerId).catch(() => undefined)
        return false
      }
      await waitForHandoff(CONNECTOR_RUNTIME_HANDOFF_POLL_MS)
      if (signal.aborted) {
        await opts.ports.release(ownerId).catch(() => undefined)
        return false
      }
      try {
        outcome = normalizeAcquireResult(
          await opts.ports.acquire(ownerId, CONNECTOR_RUNTIME_LEASE_TTL_MS)
        )
      } catch (error) {
        await opts.ports.release(ownerId).catch(() => undefined)
        const reason = error instanceof Error ? error.message : String(error)
        opts.log("error", `[connector-bus] Runtime lease handoff failed: ${reason}`)
        return false
      }
    }

    const acquired = outcome === "acquired"
    if (!acquired || signal.aborted) {
      if (acquired || handoffReserved) {
        // Aborted between the grant and here — hand it back rather than
        // holding a lease (or its handoff reservation) nobody is using.
        await opts.ports.release(ownerId).catch(() => undefined)
      }
      if (!acquired) {
        opts.log(
          "info",
          `[connector-bus] Another runtime owns the connector lease; standing down (${ownerId})`
        )
      }
      return false
    }
    opts.onLeaseAcquired?.()

    let stopped = false
    let renewing = false
    const stopLease = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      clearTimer(renewTimer)
      await opts.ports.release(ownerId).catch((error: unknown) => {
        opts.log(
          "warn",
          `[connector-bus] Runtime lease release failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    }
    const stopAfterLeaseLoss = async (): Promise<void> => {
      try {
        await opts.onLeaseLost()
      } catch (error) {
        opts.log(
          "error",
          `[connector-bus] Runtime teardown after lease loss failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      } finally {
        // Releasing acknowledges that asynchronous adapter and server
        // teardown completed. A reserved brain cannot acquire before this.
        await stopLease()
      }
    }
    const renewTimer = setTimer(() => {
      if (renewing || stopped) return
      renewing = true
      void opts.ports
        .renew(ownerId, CONNECTOR_RUNTIME_LEASE_TTL_MS)
        .then(async (renewed) => {
          if (renewed || stopped) return
          // Either the TTL lapsed or a brain preempted us. Both mean another
          // process is now the owner, so stop before it starts answering too.
          opts.log("error", "[connector-bus] Runtime lease was lost; stopping connector transports")
          await stopAfterLeaseLoss()
        })
        .catch(async (error: unknown) => {
          if (stopped) return
          opts.log(
            "error",
            `[connector-bus] Runtime lease renewal failed; stopping connector transports: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          await stopAfterLeaseLoss()
        })
        .finally(() => {
          renewing = false
        })
    }, CONNECTOR_RUNTIME_LEASE_RENEW_MS)
    signal.addEventListener("abort", () => void stopLease(), { once: true })
    return true
  }
}
