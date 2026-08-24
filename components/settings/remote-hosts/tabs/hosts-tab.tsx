"use client"

/**
 * Settings → Remote hosts → Hosts (ADR-0082, R0).
 *
 * The list itself moved to `/devices`, where a host is more than a row: its
 * feature manifest reads as a grouped matrix instead of a badge wall, its
 * workspaces are reachable once it is the routing target, and connect /
 * rename / remove sit next to the state they change. What stays here is the
 * count and the way in — adding a host and discovering one on the LAN are
 * configuration and remain the sibling tabs.
 *
 * Keeping a second list here would mean two surfaces to hold in step, and the
 * capability boundary this tab used to explain ("reads work with pairing,
 * writes need the host to grant this device control") is now stated per
 * capability in the console rather than once in a banner.
 */

import { remoteHostRef } from "@/lib/devices/build-device-rows"
import type { RemoteHostInput } from "@/lib/devices/types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { DeviceConsoleLink } from "@/components/devices/device-console-link"

export function HostsTab() {
  const hosts = useRemoteHostStore((s) => s.hosts)
  const activeHostId = useRemoteHostStore((s) => s.activeHostId)
  // Land on the host being driven when there is one — that is the row a reader
  // opening this tab almost always means.
  const active = hosts.find((host) => host.id === activeHostId)

  return (
    <DeviceConsoleLink
      surface="hosts"
      count={hosts.length}
      // Through `remoteHostRef` rather than a hand-built string: a probed host
      // is addressed by the identity it published, and a hand-built one would
      // simply not match any row.
      deviceRef={active ? remoteHostRef(active as unknown as RemoteHostInput) : undefined}
    />
  )
}
