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
 * certificate pinning, proxying and per-request DPoP signing. The renderer
 * supplies the device signing key through local IPC and owns:
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

/** Poll within companion-auth's 30-second refresh window; cached checks do no network I/O. */
const REFRESH_INTERVAL_MS = 10_000

interface RelayBinding {
  status: DesktopRelayStatus
  deviceJwt: string
  devicePrivateKeyJwk: JsonWebKey
}

interface ActiveRelay {
  endpoint: RemoteHostEndpoint
  relayPath: string
  timer: ReturnType<typeof setInterval>
  binding: RelayBinding
  refresh?: Promise<unknown>
}

let active: ActiveRelay | null = null

/**
 * Mint the device access token for the relay. The proof returned alongside it
 * is single-use and bound to this call's method/path, so the native relay must
 * sign a fresh DPoP proof for every actual upstream HTTP or WebSocket request.
 * Its signing key is handed over only through local IPC, never in a URL.
 */
async function requestDeviceToken(endpoint: RemoteHostEndpoint): Promise<string> {
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

// One token request serves concurrent IDE/port refreshes for the same pairing.
// The key contains only public identity and transport scope, never private key bytes.
const tokenRequests = new Map<string, Promise<string>>()
function mintDeviceToken(endpoint: RemoteHostEndpoint): Promise<string> {
  const identity = JSON.stringify([
    endpoint.baseUrl,
    endpoint.deviceId,
    endpoint.deviceKeyThumbprint,
    endpoint.serverFingerprint,
    endpoint.accountId,
    endpoint.devicePrivateKeyJwk.x,
    endpoint.devicePrivateKeyJwk.y,
  ])
  const pending = tokenRequests.get(identity)
  if (pending) return pending
  const request = requestDeviceToken(endpoint)
  tokenRequests.set(identity, request)
  void request
    .finally(() => {
      if (tokenRequests.get(identity) === request) tokenRequests.delete(identity)
    })
    .catch(() => undefined)
  return request
}

async function bindRelay(
  endpoint: RemoteHostEndpoint,
  relayPath: string,
  relayId?: string,
  previous?: RelayBinding
): Promise<RelayBinding> {
  // Re-checked here rather than only at the entry point: the refresh timer
  // calls straight into this, and the Rust side takes a non-optional
  // fingerprint — passing `undefined` would surface as an opaque deserialize
  // error instead of the reason.
  const serverFingerprint = endpoint.serverFingerprint
  if (!serverFingerprint) {
    throw new Error("remote host is missing its paired certificate fingerprint")
  }
  const devicePrivateKeyJwk = endpoint.devicePrivateKeyJwk
  if (!devicePrivateKeyJwk?.d) {
    throw new Error("remote host is missing its paired device signing key")
  }
  // Pinned local by the routing plane (`protocol/headless-command-dispositions.json`)
  // — this binds a socket on *this* machine, so it must never be forwarded to
  // the host it is proxying to.
  const deviceJwt = await mintDeviceToken(endpoint)
  if (
    previous?.deviceJwt === deviceJwt &&
    JSON.stringify(previous.devicePrivateKeyJwk) === JSON.stringify(devicePrivateKeyJwk)
  ) {
    return previous
  }
  const status = await transport.call<DesktopRelayStatus>("codeserver_remote_relay_ensure", {
    baseUrl: endpoint.baseUrl,
    deviceJwt,
    devicePrivateKeyJwk,
    serverFingerprint,
    relayPath,
    ...(relayId ? { relayId } : {}),
  })
  return { status, deviceJwt, devicePrivateKeyJwk: { ...devicePrivateKeyJwk } }
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
  const binding = await bindRelay(endpoint, relayPath)
  // Arm the refresh only once the first bind has actually succeeded, so a
  // failed ensure does not leave a timer hammering an unreachable host.
  stopRemoteIdeRelayRefresh()
  active = {
    endpoint,
    relayPath,
    binding,
    timer: setInterval(() => {
      const current = active
      if (!current || current.refresh) return
      current.refresh = bindRelay(current.endpoint, current.relayPath, undefined, current.binding)
        .then((next) => {
          current.binding = next
        })
        .catch(() => undefined)
        .finally(() => {
          current.refresh = undefined
        })
    }, REFRESH_INTERVAL_MS),
  }
  return binding.status
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

const portRelays = new Map<
  string,
  { timer?: ReturnType<typeof setInterval>; refresh?: Promise<unknown> }
>()
const portOperations = new Map<string, Promise<unknown>>()

function serializePort<T>(relayId: string, operation: () => Promise<T>): Promise<T> {
  const previous = portOperations.get(relayId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  portOperations.set(relayId, next)
  void next
    .finally(() => {
      if (portOperations.get(relayId) === next) portOperations.delete(relayId)
    })
    .catch(() => undefined)
  return next
}

async function stopPort(relayId: string): Promise<void> {
  const owner = portRelays.get(relayId)
  if (!owner) return
  if (owner.timer) clearInterval(owner.timer)
  await owner.refresh
  await transport.call("codeserver_remote_relay_stop", { relayId })
  portRelays.delete(relayId)
}

/** Independent credentials and lifecycle ordering for each forwarded port. */
export function ensureRemotePortRelay(
  endpoint: RemoteHostEndpoint,
  relayPath: string,
  relayId: string
): Promise<DesktopRelayStatus> {
  return serializePort(relayId, async () => {
    await stopPort(relayId)
    let binding = await bindRelay(endpoint, relayPath, relayId)
    const owner: { timer?: ReturnType<typeof setInterval>; refresh?: Promise<unknown> } = {
      timer: setInterval(() => {
        if (owner.refresh) return
        owner.refresh = bindRelay(endpoint, relayPath, relayId, binding)
          .then((next) => {
            binding = next
          })
          .catch(() => undefined)
          .finally(() => {
            owner.refresh = undefined
          })
      }, REFRESH_INTERVAL_MS),
    }
    portRelays.set(relayId, owner)
    return binding.status
  })
}

/** Queued behind create/refresh so a late bind cannot resurrect the socket. */
export function stopRemotePortRelay(relayId: string): Promise<void> {
  return serializePort(relayId, () => stopPort(relayId))
}

/** Local desktop requests stay inside the native Host; no fabricated device credential. */
export function ensureLocalPortRelay(
  localPort: { projectId: string; containerId: string; port: number },
  relayId: string
): Promise<DesktopRelayStatus> {
  return serializePort(relayId, async () => {
    await stopPort(relayId)
    const status = await transport.call<DesktopRelayStatus>("codeserver_remote_relay_ensure", {
      relayId,
      localPort,
    })
    // No credential expires on the in-process route. Keep a lease in the same
    // table so callers dispose remote and local listeners identically.
    portRelays.set(relayId, {})
    return status
  })
}
