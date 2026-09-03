/**
 * Does this client have a host paired through the host REGISTRY (ADR-0082)?
 *
 * The second of the two places a pairing can live, and the one host-profile
 * detection used to miss. `lib/platform/web-companion` reads the credential
 * book, which is what the `/pair` flow writes. Settings > Remote hosts and
 * `/devices` > "Add host" go somewhere else entirely: `addHost()` files the
 * pairing in the remote-host store's own persisted state and never touches the
 * credential book.
 *
 * That gap was invisible on the desktop, which is its own execution plane, but
 * it decided the whole question in a browser. `activeHostId` is deliberately
 * not persisted (ADR-0082, so no shell silently drives a remote machine on
 * boot), so after a reload a browser paired this way has a host and no active
 * transport. Reading only the credential book called that `web-standalone`,
 * which means "no host anywhere", and every capability-keyed settings section
 * then told a paired user that the host they are connected to does not provide
 * the thing.
 *
 * Pure leaf, synchronous, and a mirrored storage key rather than an import of
 * the store: `detectHostProfile()` runs during render and at module load, and
 * must not pull the transport, the credential vault or zustand into that path.
 * A test asserts the key stays identical to the one the store writes.
 */

/** Mirrors the `persist` name in stores/remote-host/remote-host-store.ts. */
export const REMOTE_HOST_STORE_KEY = "cognia-remote-hosts"

/**
 * True when at least one registered remote host is on file.
 *
 * Says nothing about whether it is reachable or currently driving the app.
 * That is the point: this answers "is there a host to run host-owned work on",
 * the question `hasHostRuntime` asks, and a paired host that is offline is
 * still a host. Reachability belongs to the runtime snapshot and to each
 * surface's own connection state.
 */
export function hasPairedRemoteHost(): boolean {
  if (typeof window === "undefined") return false
  try {
    const raw = window.localStorage.getItem(REMOTE_HOST_STORE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { state?: { hosts?: unknown } }
    const hosts = parsed.state?.hosts
    if (!Array.isArray(hosts)) return false
    return hosts.some(isPairedRemoteHostRow)
  } catch {
    // A denied or corrupt localStorage is not a pairing. Same fail-closed rule
    // the credential-book reader uses.
    return false
  }
}

/**
 * A registered device identity, not merely a row.
 *
 * `deviceKeyThumbprint` survives the store's `withoutPersistedSecrets` (only
 * the private JWKs are stripped) and is only ever written alongside a
 * successful registration, so it is the same proof the credential-book reader
 * keys on.
 */
function isPairedRemoteHostRow(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const config = (value as { config?: unknown }).config
  if (!config || typeof config !== "object") return false
  const record = config as Record<string, unknown>
  return (
    typeof record.baseUrl === "string" &&
    record.baseUrl.length > 0 &&
    typeof record.deviceId === "string" &&
    record.deviceId.length > 0 &&
    typeof record.deviceKeyThumbprint === "string" &&
    record.deviceKeyThumbprint.length > 0
  )
}

/**
 * Announced when the remote-host registry gains or loses a pairing.
 *
 * `hasPairedRemoteHost()` reads localStorage, which nothing observes: zustand
 * persist writes it, and a `storage` event only fires in OTHER tabs. Without
 * this the profile only widened on the next reload, so a user who had just
 * finished pairing watched Settings keep telling them they had no host, the
 * same stale answer one step later.
 *
 * A window event rather than a store subscription on purpose: `useHostProfile`
 * is imported by nearly every gated surface and must not drag the remote-host
 * store (and with it the credential vault and the transport) into that graph.
 */
export const REMOTE_HOST_PAIRING_EVENT = "cognia:remote-host-pairing-changed"

/** Call after any write that adds or removes a registered host. */
export function notifyRemoteHostPairingChanged(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(REMOTE_HOST_PAIRING_EVENT))
}

/** Subscribe to registry changes. Inert outside a browser. */
export function subscribeRemoteHostPairing(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(REMOTE_HOST_PAIRING_EVENT, onChange)
  return () => window.removeEventListener(REMOTE_HOST_PAIRING_EVENT, onChange)
}
