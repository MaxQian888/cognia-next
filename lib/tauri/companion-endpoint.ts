/**
 * Where a raw socket surface (terminal, remote browser) should connect, and the
 * identity that signs its ticket.
 *
 * Two shells reach a Cognia server, and they hold their identity in different
 * places. A paired browser or phone keeps it in the companion target book. A
 * desktop driving a *remote host* (ADR-0082) keeps it in the remote-host store,
 * which installs a per-host `CompanionTransport` with a private config provider
 * — deliberately without touching the module-level companion cache. So a
 * consumer that only read that cache resolved `null` on desktop and threw
 * `companion device identity is unavailable`, which is exactly what happened to
 * the remote browser: it could never open its frame stream from the desktop.
 *
 * The terminal solved this first; this is that resolver, lifted so both use it.
 */

import { getActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { isCapacitor } from "@/lib/tauri"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

/** The subset of a companion pairing a socket surface needs. */
export type CompanionEndpoint = Pick<
  CompanionConfig,
  | "baseUrl"
  | "deviceId"
  | "devicePrivateKeyJwk"
  | "deviceKeyThumbprint"
  | "accountId"
  | "serverVersion"
  | "serverFingerprint"
>

export type CompanionEndpointResolver = () => Promise<CompanionEndpoint | null>

export const defaultCompanionEndpointResolver: CompanionEndpointResolver = async () => {
  // Desktop driving a remote host: the endpoint lives in the remote-host store.
  const remote = getActiveRemoteEndpoint()
  if (remote) return remote
  // Capacitor and the cloud companion (ADR-0059 C1) both keep their pairing in
  // the companion target book. `pickCompanionStorage()` is already
  // shell-agnostic — it resolves the Browser Vault backend in a browser and the
  // secure-storage backend on mobile — so the only thing this gate decides is
  // whether a pairing is expected to exist at all.
  if (!isCapacitor() && !hasWebCompanionTarget()) return null
  const { pickCompanionStorage } = await import("@/lib/tauri/companion-storage")
  return pickCompanionStorage().load()
}
