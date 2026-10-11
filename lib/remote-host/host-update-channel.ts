/**
 * The owner's release channel, pushed to their always-on hosts (ADR-0224
 * A10).
 *
 * A host follows the channel its owner's Update Center follows, so a beta
 * tester's host runs beta too. This device pushes its channel to each paired
 * always-on host the first time it sees the host and whenever its own channel
 * changes, and at no other time: the host panel can give one host a channel
 * of its own, and a push on every launch would undo that. What was last
 * pushed to each host is kept device-locally for that reason.
 *
 * A host that is offline, from before self-update, or does not let this
 * device administer it is skipped and tried again on the next change.
 */

import type { UpdateChannel } from "@cognia/agent-config-types"

import { configureHostUpdate, type HostUpdateChannel } from "@/lib/remote-host/host-update"

export const PUSHED_CHANNELS_STORAGE_KEY = "cognia.hostUpdate.pushedChannels.v1"

/** The host channel for this device's channel; canary is internal, so beta. */
export function hostChannelFor(channel: UpdateChannel): HostUpdateChannel {
  return channel === "stable" ? "stable" : "beta"
}

export interface PushedChannelStore {
  read(): Record<string, HostUpdateChannel>
  write(value: Record<string, HostUpdateChannel>): void
}

export function localPushedChannelStore(): PushedChannelStore {
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(PUSHED_CHANNELS_STORAGE_KEY)
        const parsed = raw ? (JSON.parse(raw) as unknown) : null
        return parsed && typeof parsed === "object"
          ? (parsed as Record<string, HostUpdateChannel>)
          : {}
      } catch {
        return {}
      }
    },
    write(value) {
      try {
        globalThis.localStorage?.setItem(PUSHED_CHANNELS_STORAGE_KEY, JSON.stringify(value))
      } catch {
        // Without storage the channel is pushed again next launch; harmless.
      }
    },
  }
}

export interface PushChannelDeps {
  configure?: (hostId: string, patch: { channel: HostUpdateChannel }) => Promise<unknown>
  store?: PushedChannelStore
}

/**
 * Push `channel` to every host it was not last pushed to. Returns the hosts
 * that took it. Forgets hosts no longer paired.
 */
export async function pushChannelToHosts(
  channel: UpdateChannel,
  hostIds: readonly string[],
  deps: PushChannelDeps = {}
): Promise<string[]> {
  const configure = deps.configure ?? configureHostUpdate
  const store = deps.store ?? localPushedChannelStore()
  const target = hostChannelFor(channel)
  const pushed = store.read()
  const next: Record<string, HostUpdateChannel> = {}
  for (const id of hostIds) if (pushed[id]) next[id] = pushed[id]
  const took: string[] = []
  await Promise.all(
    hostIds
      .filter((id) => next[id] !== target)
      .map(async (id) => {
        try {
          await configure(id, { channel: target })
          next[id] = target
          took.push(id)
        } catch {
          // Offline, too old, or not ours to administer: next change retries.
        }
      })
  )
  store.write(next)
  return took
}
