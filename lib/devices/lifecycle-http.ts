/**
 * The HTTP leg of a device lifecycle change, for shells that are not the Host.
 *
 * `companion_suspend_device` / `companion_resume_device` /
 * `companion_revoke_device` are `target: client` commands: only the desktop
 * renderer can invoke them over Tauri IPC. The same three changes have owner
 * routes on every Host, desktop and headless alike
 * (`src-tauri/src/companion_api/server.rs`, behind `require_owner_access`):
 *
 *   POST   /api/devices/{id}/suspend
 *   POST   /api/devices/{id}/resume
 *   DELETE /api/devices/{id}
 *
 * A browser or a phone that is the Host's owner device can therefore change a
 * device's lifecycle from a distance, which is what makes the Pause / Resume /
 * Revoke buttons on `/devices` live off the desktop (ADR-0170 batch 4).
 */

import { companionAuthorizationHeaders, type AuthFetcher } from "@/lib/tauri/companion-auth"
import { pinnedFetch } from "@/lib/tauri/pinned-fetch"
import { loadCompanionConfig, type CompanionConfig } from "@/lib/tauri/transport-companion"

export type DeviceLifecycleAction = "suspend" | "resume" | "revoke"

/** Mirror of the Rust `DeviceLifecycleResponse` (`companion_api/api.rs`). */
export interface DeviceLifecycleOutcome {
  deviceId: string
  previousState?: string
  state?: string
  changed?: boolean
}

export class DeviceLifecycleNoHostError extends Error {
  constructor() {
    super("no Host is paired, so there is nowhere to send the lifecycle change")
    this.name = "DeviceLifecycleNoHostError"
  }
}

export interface DeviceLifecycleHttpDeps {
  config?: () => CompanionConfig | null
  fetcher?: AuthFetcher
}

/** The route and method one action maps to. Exported for the test only. */
export function lifecycleRoute(
  action: DeviceLifecycleAction,
  deviceId: string
): { method: "POST" | "DELETE"; path: string } {
  const id = encodeURIComponent(deviceId)
  if (action === "revoke") return { method: "DELETE", path: `/api/devices/${id}` }
  return { method: "POST", path: `/api/devices/${id}/${action}` }
}

export async function applyDeviceLifecycleOverHttp(
  action: DeviceLifecycleAction,
  deviceId: string,
  deps: DeviceLifecycleHttpDeps = {}
): Promise<DeviceLifecycleOutcome> {
  const config = (deps.config ?? loadCompanionConfig)()
  if (!config) throw new DeviceLifecycleNoHostError()
  const fetcher = deps.fetcher ?? pinnedFetch
  const { method, path } = lifecycleRoute(action, deviceId)
  const headers = await companionAuthorizationHeaders(config, method, path, fetcher)
  const response = await fetcher(`${config.baseUrl}${path}`, {
    method,
    headers: { ...headers, Accept: "application/json" },
    serverFingerprint: config.serverFingerprint,
  })
  if (!response.ok) {
    let detail = ""
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      detail = body.message ?? body.error ?? ""
    } catch {
      detail = ""
    }
    throw new Error(
      detail
        ? `the Host refused ${action} (${response.status}): ${detail}`
        : `the Host refused ${action} (${response.status})`
    )
  }
  const body = (await response.json().catch(() => ({}))) as
    DeviceLifecycleOutcome | { revokedDeviceId?: string }
  if ("revokedDeviceId" in body && body.revokedDeviceId) {
    return { deviceId: body.revokedDeviceId, state: "revoked", changed: true }
  }
  return { deviceId, ...(body as DeviceLifecycleOutcome) }
}
