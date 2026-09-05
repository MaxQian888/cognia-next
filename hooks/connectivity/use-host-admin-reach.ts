"use client"

import { useHostProfile } from "@/hooks/use-host-profile"
import {
  hostAdminReachForCommand,
  resolveHostAdminReach,
  type HostAdminReach,
  type HostAdminRequirement,
} from "@/lib/connectivity/host-admin-reach"

/**
 * The React face of `lib/connectivity/host-admin-reach.ts`: can a Host
 * configuration control run from here, bound to the live host profile.
 *
 * Owner status is left `undefined` on purpose. The paired device's `host.admin`
 * grant is only knowable from the Host's answer, and treating "unknown" as
 * "owner" keeps a control visible on a stale read. A 403 from the Host is the
 * refusal that matters, and every block renders it.
 */
export function useHostAdminReach(requirement: HostAdminRequirement): HostAdminReach {
  const profile = useHostProfile()
  return resolveHostAdminReach(requirement, { profile })
}

/** Same, keyed by the command the control will invoke. */
export function useHostAdminReachForCommand(command: string): HostAdminReach {
  const profile = useHostProfile()
  return hostAdminReachForCommand(command, { profile })
}
