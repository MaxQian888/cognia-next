/**
 * Desktop outbound routing (ADR-0082, R0).
 *
 * The desktop app is hard-wired to a local {@link TauriTransport}. To let it
 * *drive a remote Cognia host* — running terminals, files, and git on another
 * machine — the desktop transport is a {@link RoutingTransport} that delegates
 * every `call`/`subscribe` to an *active remote* transport when one is
 * installed, and otherwise passes straight through to local. With no remote
 * host active it is behaviourally identical to the wrapped local transport —
 * the zero-regression baseline.
 *
 * Switching the active host is a single pointer swap on the module-level holder
 * below; the ~480 `transport.call` sites and the `subscribe` event stream
 * follow automatically because calls resolve the current target at invocation
 * time and subscriptions are rebound by `RoutingTransport` on every active-host
 * change. Long-lived providers therefore keep one logical subscription while
 * the transport owns the local/remote listener lifecycle.
 *
 * This holder lives in `lib/tauri` with no heavy dependencies so it can be
 * imported from `transport-instance.ts` without pulling stores/UI into the
 * transport module-load path. The remote-host store (`stores/remote-host`)
 * drives it via {@link setActiveRemoteTransport}.
 */

import type { Transport } from "./transport-types"

/**
 * The currently-active remote transport, or `null` to route locally. `null` is
 * the default and the zero-regression state — the desktop starts every session
 * routing to the local host (ADR-0080: the active host is session-scoped).
 */
let activeRemote: Transport | null = null

type ActiveRemoteListener = (remote: Transport | null) => void
const listeners = new Set<ActiveRemoteListener>()

/**
 * Raw connection descriptor for the active remote host's WebSocket surfaces
 * (the interactive terminal at `/ws/v1/terminal`). The `call`/`subscribe` RPC
 * path already follows {@link activeRemote}; but the terminal opens its own
 * socket outside the `Transport` contract, so it reads this descriptor instead.
 * `baseUrl` is the host's `https://…` origin — the terminal resolver flips it to
 * `wss://`. `null` when routing locally.
 */
let activeRemoteEndpoint: RemoteHostEndpoint | null = null

/** Connection descriptor for the active remote host's raw WebSocket surfaces. */
export interface RemoteHostEndpoint {
  /** Host origin, `https://…` (flipped to `wss://` by the terminal resolver). */
  baseUrl: string
  /** Signed device JWT — the companion auth middleware reads `?token=`. */
  deviceJwt: string
  /**
   * SHA-256 fingerprint of the remote companion certificate's SPKI.
   * Required by the Pro IDE relay before it sends the device JWT upstream.
   */
  serverFingerprint?: string
}

/**
 * Commands which necessarily execute in the desktop shell even while the
 * project/runtime transport is pointed at a paired host. A remote companion
 * owns code-server, but it cannot create or position this desktop's child
 * webview, nor can it bind the desktop-side certificate-pinned relay.
 */
const LOCAL_ONLY_COMMANDS = new Set([
  "codeserver_embed_create",
  "codeserver_embed_set_background",
  "codeserver_embed_set_bounds",
  "codeserver_embed_set_visible",
  "codeserver_embed_navigate",
  "codeserver_embed_destroy",
  "codeserver_remote_relay_ensure",
  "codeserver_remote_relay_stop",
])

/**
 * Install (or clear, with `null`) the active remote transport. Idempotent: a
 * no-op when the value is unchanged, so listeners only fire on real switches.
 */
export function setActiveRemoteTransport(next: Transport | null): void {
  if (activeRemote === next) return
  activeRemote = next
  for (const listener of listeners) listener(next)
}

/** The active remote transport, or `null` when routing locally. */
export function getActiveRemoteTransport(): Transport | null {
  return activeRemote
}

/** True when a remote host is active — the desktop is driving a remote Cognia. */
export function isRemoteHostActive(): boolean {
  return activeRemote !== null
}

/**
 * Install (or clear, with `null`) the active remote host's raw-WebSocket
 * endpoint descriptor. Set together with {@link setActiveRemoteTransport} by the
 * remote-host store; read by the terminal endpoint resolver.
 */
export function setActiveRemoteEndpoint(next: RemoteHostEndpoint | null): void {
  activeRemoteEndpoint = next
}

/** The active remote host's WebSocket endpoint descriptor, or `null`. */
export function getActiveRemoteEndpoint(): RemoteHostEndpoint | null {
  return activeRemoteEndpoint
}

/**
 * Subscribe to active-remote changes. Fires with the new value on every real
 * switch (including back to `null`). Returns an idempotent unsubscribe.
 */
export function subscribeActiveRemoteTransport(listener: ActiveRemoteListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Test-only reset of the module holder. Production code switches hosts through
 * {@link setActiveRemoteTransport}; tests use this to return to a clean baseline
 * without leaking listeners across cases.
 */
export function __resetRoutingForTests(): void {
  activeRemote = null
  activeRemoteEndpoint = null
  listeners.clear()
}

/**
 * A {@link Transport} that routes to the active remote transport when one is
 * installed, else to the wrapped local transport. Faithful two-method proxy —
 * the whole contract is `call` + `subscribe`.
 */
export class RoutingTransport implements Transport {
  constructor(private readonly local: Transport) {}

  /** The transport calls resolve to right now — remote if active, else local. */
  private target(): Transport {
    return activeRemote ?? this.local
  }

  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
    if (LOCAL_ONLY_COMMANDS.has(name)) return this.local.call<T>(name, args)
    return this.target().call<T>(name, args)
  }

  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    let disposed = false
    let unsubscribeTarget = this.target().subscribe<T>(event, handler)
    const unsubscribeRouting = subscribeActiveRemoteTransport((remote) => {
      if (disposed) return
      // Bind the new target before releasing the old listener so a synchronous
      // host switch cannot create an event-loss window.
      const unsubscribeNext = (remote ?? this.local).subscribe<T>(event, handler)
      const unsubscribePrevious = unsubscribeTarget
      unsubscribeTarget = unsubscribeNext
      unsubscribePrevious()
    })

    return () => {
      if (disposed) return
      disposed = true
      unsubscribeRouting()
      unsubscribeTarget()
    }
  }
}
