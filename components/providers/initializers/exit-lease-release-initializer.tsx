"use client"

/**
 * ExitLeaseReleaseInitializer — hand run leases back when this host quits.
 *
 * A desktop that quits mid-run left its lease live, so the run stayed
 * unclaimable for the rest of the lease TTL even though its executor was
 * demonstrably gone. On a team where another machine could have picked it up,
 * that is dead time by omission.
 *
 * Mounted on desktop only: on web and mobile the tab that holds a lease is the
 * only thing that could ever run it, so there is nobody to hand it to.
 */

import { useEffect } from "react"

import { installExitLeaseRelease } from "@/lib/workflow/runtime/exit-lease-release"

export function ExitLeaseReleaseInitializer() {
  useEffect(() => installExitLeaseRelease(), [])
  return null
}

export default ExitLeaseReleaseInitializer
