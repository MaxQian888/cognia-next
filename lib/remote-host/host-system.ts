/**
 * A Host's system details from the device that manages it: its operating
 * system, kernel, processor and memory (`perf_system_details`, which an owner
 * device holds `performance.observe` for).
 *
 * Read over the Host's management channel, never the app's routing, like the
 * rest of a Host's device page (ADR-0224 A6, A10).
 */

import type { SystemDetails } from "@/lib/perf/backend/types"
import {
  withManagementChannel,
  type ManagementChannelDeps,
} from "@/lib/remote-host/management-channel"

export interface HostSystemDeps {
  channel?: ManagementChannelDeps
}

export function readHostSystemDetails(
  hostRef: string,
  deps: HostSystemDeps = {}
): Promise<SystemDetails> {
  return withManagementChannel(
    hostRef,
    (lease) => lease.transport.call<SystemDetails>("perf_system_details"),
    deps.channel
  )
}

/**
 * The operating system as one line: `Ubuntu 24.04.1 LTS`, `Darwin 15.5`, or
 * the platform alone. Null when the Host named none.
 */
export function hostOsLabel(details: Pick<SystemDetails, "os" | "osVersion">): string | null {
  const parts = [details.os, details.osVersion].map((part) => part?.trim()).filter(Boolean)
  return parts.length > 0 ? parts.join(" ") : null
}
