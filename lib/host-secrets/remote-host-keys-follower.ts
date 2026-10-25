/**
 * Keep `./remote-host-keys` current for the `/pair` Host this app drives
 * (ADR-0224 A6).
 *
 * The Host publishes no event a device can follow when a secret changes
 * (`host://secrets-changed` is service-only), so the list is read again when
 * the app moves to another Host or re-pairs, when it comes back to the
 * foreground, and after this device writes the Host's secrets
 * (`refreshRemoteHostKeys`). A read that fails for the same Host keeps what
 * was known; a member device, which may not list the Host's secrets, keys
 * nothing, which is also what the Host enforces on its turns. It is not asked
 * at all once the Host's manifest says so, and nothing is asked before that
 * manifest lands: each read used to be refused, at boot and again on every
 * return to the foreground.
 */

import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { hostGrantGate, type HostGrantGate } from "@/lib/runtime/operation-availability"
import { getRuntimeSnapshot, subscribeRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
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
  /** Whether this device may list the driven Host's secrets now. */
  access?: () => HostGrantGate
  /** Calls `onChange` whenever the driven Host, or {@link access}, may have changed. */
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

/** What listing a Host's secrets needs (`protocol/companion-commands.json`). */
const HOST_SECRET_LIST_CAPABILITY = getCommandDescriptor("host_secret_list")?.capability

function secretsAccess(): HostGrantGate {
  return HOST_SECRET_LIST_CAPABILITY
    ? hostGrantGate(getRuntimeSnapshot(), HOST_SECRET_LIST_CAPABILITY)
    : "ask"
}

function subscribeDrivenHost(onChange: () => void): () => void {
  // The snapshot changes on every connection step; only a changed answer
  // (the manifest landed, or a re-pair moved the grants) is worth a read.
  let access = secretsAccess()
  const stopSnapshot = subscribeRuntimeSnapshot(() => {
    const next = secretsAccess()
    if (next === access) return
    access = next
    onChange()
  })
  const stopRuntimeTarget = subscribeRuntimeTargetContext(onChange)
  const stopTarget = () => {
    stopSnapshot()
    stopRuntimeTarget()
  }
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
  const access = deps.access ?? secretsAccess
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
      const gate = access()
      // Not yet known: the read waits for the manifest (a change re-reads).
      if (gate === "wait") return
      // A device that may not list them keys nothing, as a refusal would.
      if (gate === "lacks") {
        clearRemoteHostKeyedProviders()
        return
      }
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
