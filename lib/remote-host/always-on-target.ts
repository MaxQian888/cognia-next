/**
 * Where new always-on work goes by default (ADR-0224 A5 step 7).
 *
 * When the user has paired an always-on host and it answered its last
 * liveness check, a new scheduled task, Bot or connection is offered to it
 * first: that is the machine that stays up. A host that did not answer is
 * not a default anyone should land on, so it is skipped rather than chosen
 * and then failed. Several always-on hosts: the first one paired leads, the
 * same order the device console lists them in.
 */

import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

export function alwaysOnTarget(hosts: readonly RemoteHost[]): RemoteHost | null {
  return hosts.find((host) => host.alwaysOn && host.lastProbe?.ok === true) ?? null
}
