/**
 * Provider keys a paired device sealed on this host (ADR-0224 A6).
 *
 * An always-on host runs scheduled tasks and Bots with nobody at it, and a
 * provider key is a `desktop-only` setting that never syncs, so the host's own
 * settings usually have none. A paired owner device can seal keys on the host
 * instead (`host_provider_credential_set`); this module holds them in memory
 * for the host's runtime and `createProviderSettingsSnapshot` fills them into
 * any provider whose own key is blank. A key the host's settings carry always
 * wins: the overlay only answers where there was nothing.
 *
 * Loaded at start and again whenever the host publishes
 * `host://secrets-changed` (a key set, removed, or swept with a revoked
 * device). The keys never reach Dexie, settings, or any other device: the
 * load command is service-internal on a headless brain and a local Tauri
 * command on a desktop host.
 */

import { isHeadlessHost } from "@/lib/platform/detect"
import { isTauri } from "@/lib/tauri"

import { hostProviderKeyCount, replaceHostProviderKeys } from "./provider-key-store"

export {
  hostProviderKey,
  overlayHostProviderKeys,
  replaceHostProviderKeys,
} from "./provider-key-store"

/** The event the host publishes after any host secret changes. */
export const HOST_SECRETS_CHANGED_EVENT = "host://secrets-changed"
/** The host's own command returning the sealed provider keys. */
export const HOST_PROVIDER_KEYS_LOAD = "host_provider_credentials_load"

interface LoadedKeys {
  keys: Array<{ providerId: string; apiKey: string }>
}

export interface HostProviderKeyDeps {
  load: () => Promise<LoadedKeys>
  subscribe: (onChange: () => void) => Promise<() => void> | (() => void)
  log?: (level: "warn" | "error", message: string) => void
}

/** Where this process's keys come from, or null where there is no host store. */
export function defaultHostProviderKeyDeps(): HostProviderKeyDeps | null {
  if (isHeadlessHost()) {
    return {
      load: async () => {
        const { transport } = await import("@/lib/tauri")
        return transport.call<LoadedKeys>(HOST_PROVIDER_KEYS_LOAD, {})
      },
      subscribe: async (onChange) => {
        const { transport } = await import("@/lib/tauri")
        return transport.subscribe<unknown>(HOST_SECRETS_CHANGED_EVENT, () => onChange())
      },
    }
  }
  if (isTauri()) {
    // The desktop's own commands and events, never `transport`: a desktop
    // driving a paired host routes `transport` there, and the keys wanted
    // here are the ones sealed on this machine.
    return {
      load: async () => {
        const { invoke } = await import("@tauri-apps/api/core")
        return invoke<LoadedKeys>(HOST_PROVIDER_KEYS_LOAD)
      },
      subscribe: async (onChange) => {
        const { listen } = await import("@tauri-apps/api/event")
        return listen(HOST_SECRETS_CHANGED_EVENT, () => onChange())
      },
    }
  }
  return null
}

/** Read the sealed keys into the overlay. Resolves to how many there are. */
export async function loadHostProviderKeys(deps: Pick<HostProviderKeyDeps, "load">) {
  const loaded = await deps.load()
  replaceHostProviderKeys(
    (loaded?.keys ?? []).map((entry) => [entry.providerId, entry.apiKey] as const)
  )
  return hostProviderKeyCount()
}

export interface InstalledHostProviderKeys {
  /** Settles once the first load has finished, whether or not it found keys. */
  ready: Promise<void>
  /** Stop following changes and empty the overlay. */
  stop: () => void
}

/**
 * Load now and reload on every change, one load at a time. `stop` also
 * empties the overlay: keys outlive nothing that loaded them. A failed load
 * keeps what the overlay already held, so a host whose secret store is
 * briefly unreadable does not drop every key mid-run.
 */
export function installHostProviderKeys(deps: HostProviderKeyDeps): InstalledHostProviderKeys {
  let stopped = false
  let pending = Promise.resolve()
  let unsubscribe: (() => void) | null = null
  const log = deps.log ?? ((level, message) => console[level](message))

  const reload = () => {
    pending = pending.then(async () => {
      if (stopped) return
      try {
        await loadHostProviderKeys(deps)
      } catch (error) {
        log(
          "warn",
          `host provider keys could not be loaded: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
    return pending
  }

  const ready = reload()
  void Promise.resolve(deps.subscribe(() => void reload()))
    .then((stop) => {
      if (stopped) stop()
      else unsubscribe = stop
    })
    .catch((error) =>
      log(
        "error",
        `host provider keys will not follow changes: ${error instanceof Error ? error.message : String(error)}`
      )
    )

  return {
    ready,
    stop: () => {
      stopped = true
      unsubscribe?.()
      replaceHostProviderKeys([])
    },
  }
}
