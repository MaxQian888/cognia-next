/**
 * Which `connectors_*` commands a paired DEVICE may reach, and whether this
 * shell has to use that route at all.
 *
 * ## Why a list and not "all of them"
 *
 * The 42 `connectors_*` manifest entries were, until ADR-0152, uniformly
 * `target: service` with an empty `transports` list — a shape no device can
 * reach, because `api.rs` refuses the transport before the RPC layer's
 * service-only gate even runs. The desktop worked regardless, since Tauri
 * `invoke` bypasses that protocol face entirely, which is exactly why the
 * discrepancy went unnoticed for so long.
 *
 * ADR-0152 raised the four keyring arms — and only those — onto the device
 * plane behind `host.admin` plus an admin lease. Routing the other thirty-eight
 * over the transport would not make them work; it would swap the clear
 * "this control talks to the runtime process" explanation that
 * `lib/connectors/control-reach.ts` renders for a raw 403. So the list is the
 * honest surface, and `device-plane.test.ts` pins it against
 * `protocol/companion-commands.json` so it cannot drift from the manifest the
 * host actually enforces.
 *
 * ## Why the lease lives here
 *
 * `lib/connectors/tauri/commands.ts` must attach `adminLease` to a device-plane
 * call, and `lib/connectors/credential-lease.ts` must decide when to acquire
 * one. Holding the token in this leaf keeps the acquisition policy out of the
 * command wrappers and keeps the wrappers out of `@/lib/tauri`'s import graph.
 */

import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"

/**
 * `connectors_*` commands a device-scoped caller may reach (ADR-0152).
 *
 * Every entry must be `target: host-admin` in `protocol/companion-commands.json`
 * with `http` among its transports, and every such command must appear here —
 * both directions are asserted by the co-located test.
 */
export const DEVICE_PLANE_CONNECTOR_COMMANDS: readonly string[] = Object.freeze([
  "connectors_keyring_set",
  "connectors_keyring_get",
  "connectors_keyring_delete",
  "connectors_keyring_list",
])

const DEVICE_PLANE = new Set(DEVICE_PLANE_CONNECTOR_COMMANDS)

/** True when a device-scoped caller is allowed to reach `name`. */
export function isDevicePlaneConnectorCommand(name: string): boolean {
  return DEVICE_PLANE.has(name)
}

/**
 * True when this shell's keyring lives on a host it is paired to, so the
 * device plane is the only route to it.
 *
 * Keyed on the profile rather than on `!isTauri()`, because the question is
 * "is there a host holding these credentials", not "is there local IPC".
 * The distinction matters at both ends:
 *
 * - `web-standalone` has no host to ask, so routing would only swap one
 *   failure message for another while making a doomed round trip look like a
 *   real attempt.
 * - `headless` replaces the whole invoker with its own in-process one
 *   (`lib/headless/runtimes/connector-runtime.ts`), and a brain reaching its
 *   own keyring through a lease it would have to grant itself is a loop.
 *
 * It is also the same question `credentialLeaseRequired` asks, and sharing
 * one answer is what keeps a call from being routed somewhere the lease
 * logic never expected it to go.
 */
export function connectorCommandsNeedTransport(
  profile: HostProfile = detectHostProfile()
): boolean {
  return profile === "mobile-companion" || profile === "cloud-companion"
}

let leaseToken: string | null = null

/**
 * Install (or clear) the admin lease every subsequent device-plane call
 * carries. Owned by `lib/connectors/credential-lease.ts`; nothing else should
 * write it.
 */
export function setConnectorDeviceLease(token: string | null): void {
  leaseToken = token
}

/** The lease token to attach, or `null` to send the call without one. */
export function connectorDeviceLease(): string | null {
  return leaseToken
}
