"use client"

import { useEffect } from "react"

import { hasCapability } from "@/lib/platform/capabilities"
import { pushChannelToHosts } from "@/lib/remote-host/host-update-channel"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Coalesces a burst of store changes (hydration, pairing) into one push. */
export const HOST_CHANNEL_PUSH_DELAY_MS = 2_000

function alwaysOnHostIds(): string[] {
  return useRemoteHostStore
    .getState()
    .hosts.filter((host) => host.alwaysOn === true && host.connectionState !== "revoked")
    .map((host) => host.id)
    .sort()
}

/**
 * Push this device's Update Center channel to its always-on hosts (ADR-0224
 * A10): when a host is paired, and when the channel changes. Desktop only, the
 * shell that keeps paired hosts and their management channels.
 */
export function HostUpdateChannelInitializer({
  push = pushChannelToHosts,
}: {
  push?: typeof pushChannelToHosts
}) {
  useEffect(() => {
    if (!hasCapability("always-on")) return
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = () => {
      const settings = useSettingsStore.getState()
      // Before settings load the channel would read as the default.
      if (!settings.loaded) return
      const hosts = alwaysOnHostIds()
      if (hosts.length === 0) return
      void push(settings.settings?.updateCenter?.channel ?? "stable", hosts)
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, HOST_CHANNEL_PUSH_DELAY_MS)
    }

    const unsubscribeSettings = useSettingsStore.subscribe((next, previous) => {
      if (
        next.loaded !== previous.loaded ||
        next.settings?.updateCenter?.channel !== previous.settings?.updateCenter?.channel
      ) {
        schedule()
      }
    })
    let hostKey = alwaysOnHostIds().join(",")
    const unsubscribeHosts = useRemoteHostStore.subscribe(() => {
      const key = alwaysOnHostIds().join(",")
      if (key === hostKey) return
      hostKey = key
      schedule()
    })
    schedule()

    return () => {
      if (timer) clearTimeout(timer)
      unsubscribeSettings()
      unsubscribeHosts()
    }
  }, [push])

  return null
}

export default HostUpdateChannelInitializer
