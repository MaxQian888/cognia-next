import type { OcrProvider } from "./types"
import type { NativePlatform } from "./types/platform"
import { shellAllows } from "./registry"

export type OcrUnavailableReason =
  | "unsupported-shell"
  | "backend-not-bound"
  | "model-missing"
  | "model-corrupt"
  | "missing-credentials"
  | "configuration-required"

export interface OcrModelRuntimeStatus {
  variant?: string
  version?: string
  installed: boolean
  integrity: "verified" | "missing" | "corrupt" | "unknown"
}

/** Single provider-readiness contract consumed by routing, probes, and settings. */
export interface OcrRuntimeStatus {
  providerId: string
  shellSupported: boolean
  backendBound?: boolean
  model?: OcrModelRuntimeStatus
  credentialsConfigured?: boolean
  ready: boolean
  reason?: OcrUnavailableReason
  detail?: string
}

export type OcrRuntimeStatusResolver = (
  provider: OcrProvider,
  platform: NativePlatform
) => OcrRuntimeStatus | Promise<OcrRuntimeStatus>

/** Conservative fallback used when a host does not install a richer resolver. */
export function staticRuntimeStatus(
  provider: OcrProvider,
  platform: NativePlatform
): OcrRuntimeStatus {
  const shellSupported = shellAllows(provider, platform)
  return {
    providerId: provider.id,
    shellSupported,
    ready: shellSupported,
    reason: shellSupported ? undefined : "unsupported-shell",
  }
}
