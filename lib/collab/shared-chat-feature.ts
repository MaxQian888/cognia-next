/**
 * Whether this app exposes the server-authoritative shared chat plane.
 *
 * # Two switches, not one
 *
 * `NEXT_PUBLIC_SHARED_CHAT_ENABLED` is the master switch and stays exactly
 * what it was: a build-time decision that fails closed, so a shipped binary
 * that was never meant to carry the plane cannot be talked into it at runtime.
 *
 * Underneath it there is now a per-installation preference. The build flag
 * alone left the whole plane in one of the two states this repository gets
 * wrong most often: fully built, fully tested, and reachable by nobody. An
 * operator who turns the flag on for their fleet still wants individual
 * machines to be able to say no, and somebody evaluating the plane wants to
 * turn it off again without a rebuild.
 *
 * The preference can only ever subtract. With the build flag off the answer is
 * no whatever the local choice says, which is what keeps the master switch a
 * master switch.
 *
 * # Absent means yes
 *
 * A machine that has never expressed a preference behaves exactly as it did
 * before this existed. That matters because the flag is already set to true in
 * the Playwright config and in every deployment that opted in, and a new
 * default of "off" would have silently retired the plane for all of them.
 */

const ENABLED_VALUE = "true"

const PREFERENCE_STORAGE_KEY = "cognia.collab.shared-chat-enabled"
const PREFERENCE_CHANGED_EVENT = "cognia:shared-chat-preference-changed"

/** Storage seam so tests need no `localStorage`, matching `lib/collab/connection.ts`. */
export interface SharedChatPreferenceDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function store(deps: SharedChatPreferenceDeps): SharedChatPreferenceDeps["local"] | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

/**
 * The build-time master switch on its own.
 *
 * Exported because the settings surface has to tell "you turned this off" and
 * "this build does not carry it" apart. Collapsing those two into one hidden
 * control is how a fixable state gets mistaken for an impossible one.
 */
export function isSharedChatBuildEnabled(
  configuredValue: string | undefined = process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED,
  environment: string | undefined = process.env.NODE_ENV
): boolean {
  if (configuredValue === undefined) return environment === "test"
  return configuredValue.trim().toLowerCase() === ENABLED_VALUE
}

/** The local choice, or `undefined` when this machine has never made one. */
export function readSharedChatPreference(deps: SharedChatPreferenceDeps = {}): boolean | undefined {
  const local = store(deps)
  if (!local) return undefined
  let raw: string | null = null
  try {
    raw = local.getItem(PREFERENCE_STORAGE_KEY)
  } catch {
    // Private-mode Safari and a storage-blocked webview both throw on read.
    // No stored opinion is the honest answer there.
    return undefined
  }
  if (raw === "true") return true
  if (raw === "false") return false
  return undefined
}

/** Record the local choice. `undefined` forgets it and restores the default. */
export function writeSharedChatPreference(
  enabled: boolean | undefined,
  deps: SharedChatPreferenceDeps = {}
): void {
  const local = store(deps)
  try {
    if (enabled === undefined) local?.removeItem(PREFERENCE_STORAGE_KEY)
    else local?.setItem(PREFERENCE_STORAGE_KEY, enabled ? "true" : "false")
  } catch {
    // A write that cannot land leaves the previous answer in place. Throwing
    // here would take down the settings card over a preference.
  }
  if (!deps.local && typeof window !== "undefined") {
    window.dispatchEvent(new Event(PREFERENCE_CHANGED_EVENT))
  }
}

export function subscribeSharedChatPreference(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(PREFERENCE_CHANGED_EVENT, listener)
  return () => window.removeEventListener(PREFERENCE_CHANGED_EVENT, listener)
}

/**
 * The one question every caller asks: may this runtime touch shared chat?
 *
 * Kept under its original name so the entry points, the sync pulls, the run
 * coordinator and the conversion path all pick the preference up without a
 * single call site changing. A gate that some callers consult and others do
 * not is worse than no gate.
 */
export function isSharedChatClientEnabled(
  configuredValue?: string | undefined,
  environment?: string | undefined,
  deps: SharedChatPreferenceDeps = {}
): boolean {
  if (!isSharedChatBuildEnabled(configuredValue, environment)) return false
  return readSharedChatPreference(deps) !== false
}

export function assertSharedChatClientEnabled(): void {
  if (!isSharedChatClientEnabled()) throw new Error("SHARED_CHAT_DISABLED")
}
