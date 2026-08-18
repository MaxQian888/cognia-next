/**
 * Desktop half of the remote-host Pro IDE relay (ADR-0088 / ADR-0082).
 *
 * When the app is driving a paired remote host, code-server runs *there*, on a
 * loopback port nothing off that machine can reach. The host exposes it behind
 * its companion front door at `relayPath` (`/ide/relay/<opaque-id>/`), and the
 * desktop binds an ephemeral loopback relay that pins the host certificate and
 * injects the device credential per request — so the embedded webview only ever
 * navigates to `http://127.0.0.1:<port>/` and no credential is ever in a URL.
 *
 * The Rust relay (`src-tauri/src/codeserver/relay.rs`) owns the socket, the
 * certificate pinning and the proxying. What has to live here is the part that
 * needs the device private key, which only the renderer holds:
 *
 *  - minting the device access token the relay presents upstream, and
 *  - re-minting it before it expires.
 *
 * Device access tokens live five minutes (`ACCESS_TOKEN_TTL_SECS` in
 * `src-tauri/src/companion_api/api.rs`). A relay bound once with a single token
 * would start answering 401 a few minutes into a session and take the workbench
 * down with it, so this module keeps a refresh timer for as long as a relay is
 * up. Re-`ensure`ing with the same host + relay path + fingerprint swaps the
 * credential *in place* and keeps the port, which is what lets the live VS Code
 * session survive a refresh.
 */
import { companionAuthorizationHeaders } from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { transport } from "@/lib/tauri"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"

/** Mirror of `codeserver::relay::DesktopRelayStatus`. */
export interface DesktopRelayStatus {
  port: number
  url: string
}

/**
 * Re-mint this far ahead of the five-minute expiry. Wide enough that a slow
 * challenge/token round-trip on a loaded host still lands before the old token
 * dies, and it costs two cheap requests a minute and a half.
 */
const REFRESH_INTERVAL_MS = 3.5 * 60 * 1000

interface ActiveRelay {
  endpoint: RemoteHostEndpoint
  relayPath: string
  timer: ReturnType<typeof setInterval>
}

let active: ActiveRelay | null = null

/**
 * The relay is authenticated with an ordinary device access token, not a socket
 * ticket: the companion mounts `/ide/relay/...` behind `require_device_access`,
 * which takes a `Bearer` bound to the device key. `companionAuthorizationHeaders`
 * also returns a DPoP proof, which is dropped — proofs are single-use and bound
 * to one method+path, so it could not be replayed across the many requests a
 * workbench makes anyway, and that route does not ask for one.
 */
async function mintDeviceToken(endpoint: RemoteHostEndpoint): Promise<string> {
  const config: CompanionConfig = {
    baseUrl: endpoint.baseUrl,
    deviceId: endpoint.deviceId,
    serverVersion: endpoint.serverVersion,
    devicePrivateKeyJwk: endpoint.devicePrivateKeyJwk,
    deviceKeyThumbprint: endpoint.deviceKeyThumbprint,
    serverFingerprint: endpoint.serverFingerprint,
    accountId: endpoint.accountId,
  }
  const headers = await companionAuthorizationHeaders(config, "GET", "/ide/relay")
  const bearer = headers.Authorization?.replace(/^Bearer\s+/i, "").trim()
  if (!bearer) throw new Error("remote host did not issue a device access token")
  return bearer
}

async function bindRelay(
  endpoint: RemoteHostEndpoint,
  relayPath: string
): Promise<DesktopRelayStatus> {
  // Re-checked here rather than only at the entry point: the refresh timer
  // calls straight into this, and the Rust side takes a non-optional
  // fingerprint — passing `undefined` would surface as an opaque deserialize
  // error instead of the reason.
  const serverFingerprint = endpoint.serverFingerprint
  if (!serverFingerprint) {
    throw new Error("remote host is missing its paired certificate fingerprint")
  }
  // Pinned local by the routing plane (`protocol/headless-command-dispositions.json`)
  // — this binds a socket on *this* machine, so it must never be forwarded to
  // the host it is proxying to.
  return transport.call<DesktopRelayStatus>("codeserver_remote_relay_ensure", {
    baseUrl: endpoint.baseUrl,
    deviceJwt: await mintDeviceToken(endpoint),
    serverFingerprint,
    relayPath,
  })
}

/**
 * Bind (or reuse) the loopback relay for `relayPath` on `endpoint` and keep its
 * credential fresh. Returns the loopback port the pane should navigate to.
 *
 * Safe to call repeatedly: the backend keys the running relay on host + path +
 * fingerprint, so a repeat call refreshes the token and hands back the same
 * port rather than rebinding.
 */
export async function ensureRemoteIdeRelay(
  endpoint: RemoteHostEndpoint,
  relayPath: string
): Promise<DesktopRelayStatus> {
  const status = await bindRelay(endpoint, relayPath)
  // Arm the refresh only once the first bind has actually succeeded, so a
  // failed ensure does not leave a timer hammering an unreachable host.
  stopRemoteIdeRelayRefresh()
  active = {
    endpoint,
    relayPath,
    timer: setInterval(() => {
      const current = active
      if (!current) return
      // Swallowed on purpose: a single missed refresh is recoverable (the next
      // tick is still inside the token's lifetime), and there is no user action
      // that would help. A relay that really is gone surfaces through the
      // pane's own health watchdog instead.
      void bindRelay(current.endpoint, current.relayPath).catch(() => undefined)
    }, REFRESH_INTERVAL_MS),
  }
  return status
}

/** Stop refreshing. Called when the relay itself is torn down. */
export function stopRemoteIdeRelayRefresh(): void {
  if (!active) return
  clearInterval(active.timer)
  active = null
}

/** Whether a relay credential refresh is currently armed. */
export function isRemoteIdeRelayActive(): boolean {
  return active !== null
}

/** Test-only: drop the timer without touching the (mocked) native layer. */
export function __resetRemoteIdeRelayForTesting(): void {
  stopRemoteIdeRelayRefresh()
}
