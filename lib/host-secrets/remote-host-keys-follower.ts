/**
 * Keep `./remote-host-keys` current for the `/pair` Host this app drives
 * (ADR-0224 A6).
 *
 * The Host publishes no event a device can follow when a secret changes
 * (`host://secrets-changed` is service-only), so the list is read again when
 * the app moves to another Host or re-pairs, when it comes back to the
 * foreground, and after this device writes the Host's secrets
 * (`refreshRemoteHostKeys`). A read that fails for the same Host keeps what
 * was known; a member device, which may not list the Host's secrets, is told
 * no and keys nothing, which is also what the Host enforces on its turns.
 */

import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

import {
  clearRemoteHostKeyedProviders,
  REMOTE_HOST_KEYS_REFRESH_EVENT,
  remoteHostKeysHostId,
  setRemoteHostKeyedProviders,
} from "./remote-host-keys"

export { refreshRemoteHostKeys } from "./remote-host-keys"

/** Mirrors `notifyCompanionConfigChanged` in lib/tauri/transport-companion. */
const COMPANION_CONFIG_EVENT = "cognia:companion-config-changed"

export interface RemoteHostKeysFollowerDeps {
  /** The `/pair` Host this app drives, or null when it drives none. */
  drivenHostId?: () => string | null
  /** The provider ids the Host holds a key for. */
  listProviders?: (hostId: string) => Promise<string[]>
  /** Calls `onChange` whenever the driven Host may have changed. */
  subscribe?: (onChange: () => void) => () => void
  log?: (message: string) => void
}

/** The `/pair` Host the app's own transport is connected to, if any. */
export function drivenPairedHostId(): string | null {
  const active = getActiveRuntimeTargetContext()
  const config = loadCompanionConfig()
  if (!active || !config?.targetId || config.targetId !== active.targetId) return null
  return config.targetId
}

async function listProviderKeys(hostId: string): Promise<string[]> {
  const [{ listHostSecrets }, { PAIRED_HOST_REF_PREFIX }] = await Promise.all([
    import("@/lib/remote-host/host-secrets"),
    import("@/lib/remote-host/target-transport"),
  ])
  const entries = await listHostSecrets(`${PAIRED_HOST_REF_PREFIX}${hostId}`)
  return entries.filter((entry) => entry.kind === "provider").map((entry) => entry.name)
}

function subscribeDrivenHost(onChange: () => void): () => void {
  const stopTarget = subscribeRuntimeTargetContext(onChange)
  if (typeof window === "undefined") return stopTarget
  const onVisible = () => {
    if (document.visibilityState === "visible") onChange()
  }
  window.addEventListener(COMPANION_CONFIG_EVENT, onChange)
  window.addEventListener(REMOTE_HOST_KEYS_REFRESH_EVENT, onChange)
  document.addEventListener("visibilitychange", onVisible)
  return () => {
    stopTarget()
    window.removeEventListener(COMPANION_CONFIG_EVENT, onChange)
    window.removeEventListener(REMOTE_HOST_KEYS_REFRESH_EVENT, onChange)
    document.removeEventListener("visibilitychange", onVisible)
  }
}

export interface RemoteHostKeysFollower {
  /** Settles once the first read has finished. */
  ready: Promise<void>
  /** Stop following and forget the ids. */
  stop: () => void
}

/** Read now and on every change, one read at a time; the newest read wins. */
export function followRemoteHostKeys(
  deps: RemoteHostKeysFollowerDeps = {}
): RemoteHostKeysFollower {
  const drivenHostId = deps.drivenHostId ?? drivenPairedHostId
  const listProviders = deps.listProviders ?? listProviderKeys
  const log = deps.log ?? ((message) => console.warn(message))
  let stopped = false
  let generation = 0
  let pending = Promise.resolve()

  const reload = () => {
    const ticket = ++generation
    pending = pending.then(async () => {
      if (stopped || ticket !== generation) return
      const hostId = drivenHostId()
      if (!hostId) {
        clearRemoteHostKeyedProviders()
        return
      }
      if (remoteHostKeysHostId() !== hostId) clearRemoteHostKeyedProviders()
      try {
        const providers = await listProviders(hostId)
        if (stopped || ticket !== generation || drivenHostId() !== hostId) return
        setRemoteHostKeyedProviders(hostId, providers)
      } catch (error) {
        log(
          `the Host's provider keys could not be listed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
    return pending
  }

  const ready = reload()
  const unsubscribe = (deps.subscribe ?? subscribeDrivenHost)(() => void reload())

  return {
    ready,
    stop: () => {
      stopped = true
      unsubscribe()
      clearRemoteHostKeyedProviders()
    },
  }
}
