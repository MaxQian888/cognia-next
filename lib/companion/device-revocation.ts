"use client"

import { companionAuthorizationHeaders, type AuthFetcher } from "@/lib/tauri/companion-auth"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { pinnedFetch } from "@/lib/tauri/pinned-fetch"

export type DeviceRevocationResult = { kind: "revoked" } | { kind: "already-revoked" }

export class CompanionDeviceRevocationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "CompanionDeviceRevocationError"
  }
}

interface DeviceRevocationDependencies {
  authorize?: typeof companionAuthorizationHeaders
  fetcher?: AuthFetcher
}

/**
 * Revoke one device using that Host's explicit config. This deliberately does
 * not consult the active transport: active-target fallback may already have
 * completed, while revocation still belongs to the removed Host and pin.
 */
export async function revokeCompanionDevice(
  config: CompanionConfig,
  dependencies: DeviceRevocationDependencies = {}
): Promise<DeviceRevocationResult> {
  const authorize = dependencies.authorize ?? companionAuthorizationHeaders
  const fetcher = dependencies.fetcher ?? pinnedFetch
  const path = `/api/devices/${encodeURIComponent(config.deviceId)}`

  let response: Response
  try {
    const headers = await authorize(config, "DELETE", path, fetcher)
    response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "DELETE",
      headers,
      serverFingerprint: config.serverFingerprint,
    })
  } catch (error) {
    if (error instanceof CompanionDeviceRevocationError) throw error
    throw new CompanionDeviceRevocationError("network", 0, true, errorMessage(error), {
      cause: error,
    })
  }

  const body = await response.json().catch(() => null)
  if (response.ok) return { kind: "revoked" }

  const detail = readErrorDetail(body)
  if (detail.code === "device_revoked") return { kind: "already-revoked" }
  throw new CompanionDeviceRevocationError(
    detail.code ?? `http_${response.status}`,
    response.status,
    detail.retryable ?? response.status >= 500,
    detail.message ?? `HTTP ${response.status}`
  )
}

function readErrorDetail(body: unknown): {
  code?: string
  message?: string
  retryable?: boolean
} {
  if (!body || typeof body !== "object") return {}
  const root = body as Record<string, unknown>
  const nested =
    root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root
  return {
    code: typeof nested.code === "string" ? nested.code : undefined,
    message: typeof nested.message === "string" ? nested.message : undefined,
    retryable: typeof nested.retryable === "boolean" ? nested.retryable : undefined,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
