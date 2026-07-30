import { APP_VERSION } from "@/lib/app-version"
import type { Platform } from "./detect"

export const HOST_FEATURE_MANIFEST_SCHEMA_VERSION = 1 as const

export const HOST_FEATURE_IDS = [
  "claude.host-tools",
  "claude.controller-tool-proxy",
  "skills.catalog",
  "skills.session-attach",
  "skills.atomic-install",
  "external-bridge.lifecycle",
  "external-bridge.managed-relay",
  "external-bridge.direct-tls",
] as const

export type HostFeatureId = (typeof HOST_FEATURE_IDS)[number]

export interface HostFeatureDescriptor {
  version: number
  operations: string[]
}

export interface HostFeatureLimits {
  rpcJsonBodyBytes: number
  skillMaxResources: number
  skillMaxResourceBytes: number
  skillUploadChunkBytes: number
  mcpRequestBodyBytes: number
  maxConcurrentProxyCalls: number
}

export interface HostFeatureManifest {
  schemaVersion: typeof HOST_FEATURE_MANIFEST_SCHEMA_VERSION
  hostBuildId: string
  platform: Platform
  generatedAt: number
  features: Partial<Record<HostFeatureId, HostFeatureDescriptor>>
  limits: HostFeatureLimits
}

const DEFAULT_LIMITS: HostFeatureLimits = Object.freeze({
  rpcJsonBodyBytes: 64 * 1024,
  skillMaxResources: 50,
  skillMaxResourceBytes: 2 * 1024 * 1024,
  skillUploadChunkBytes: 32 * 1024,
  mcpRequestBodyBytes: 1024 * 1024,
  maxConcurrentProxyCalls: 32,
})

/**
 * Build the manifest for operations that are already complete end to end.
 *
 * New features must be added only after their transport, authorization and
 * host dispatch paths ship together. Absence is the compatibility signal for
 * older or partially upgraded hosts.
 */
export function buildLocalHostFeatureManifest({
  hostBuildId = APP_VERSION,
  platform,
}: {
  hostBuildId?: string
  platform: Platform
}): HostFeatureManifest {
  return {
    schemaVersion: HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
    hostBuildId,
    platform,
    generatedAt: Date.now(),
    features: {
      "claude.host-tools": {
        version: 1,
        operations: [
          "claude_send",
          "claude_interrupt",
          "claude_compact",
          "claude_close_session",
          "claude_restore",
          "claude_set_mode",
          "claude_sidecar_status",
        ],
      },
      "skills.catalog": {
        version: 1,
        operations: ["skills_catalog_get", "skills_load_registry", "skills_scan_native"],
      },
    },
    limits: { ...DEFAULT_LIMITS },
  }
}

export function supportsHostFeatureOperation(
  manifest: HostFeatureManifest | null | undefined,
  feature: HostFeatureId,
  operation?: string
): boolean {
  const descriptor = manifest?.features[feature]
  if (!descriptor) return false
  return operation === undefined || descriptor.operations.includes(operation)
}

export function parseHostFeatureManifest(value: unknown): HostFeatureManifest | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<HostFeatureManifest>
  if (
    candidate.schemaVersion !== HOST_FEATURE_MANIFEST_SCHEMA_VERSION ||
    typeof candidate.hostBuildId !== "string" ||
    candidate.hostBuildId.length === 0 ||
    candidate.hostBuildId.length > 128 ||
    !["tauri", "mobile", "web", "headless"].includes(candidate.platform ?? "") ||
    typeof candidate.generatedAt !== "number" ||
    !Number.isFinite(candidate.generatedAt) ||
    candidate.generatedAt <= 0 ||
    !candidate.features ||
    typeof candidate.features !== "object" ||
    !candidate.limits ||
    typeof candidate.limits !== "object"
  ) {
    return null
  }

  const limits = candidate.limits as Partial<HostFeatureLimits>
  if (
    ![
      limits.rpcJsonBodyBytes,
      limits.skillMaxResources,
      limits.skillMaxResourceBytes,
      limits.skillUploadChunkBytes,
      limits.mcpRequestBodyBytes,
      limits.maxConcurrentProxyCalls,
    ].every((limit) => typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0)
  ) {
    return null
  }

  for (const [feature, descriptor] of Object.entries(candidate.features)) {
    const operations =
      descriptor && typeof descriptor === "object" && Array.isArray(descriptor.operations)
        ? descriptor.operations
        : []
    if (
      !HOST_FEATURE_IDS.includes(feature as HostFeatureId) ||
      !descriptor ||
      typeof descriptor !== "object" ||
      !Number.isSafeInteger(descriptor.version) ||
      descriptor.version <= 0 ||
      operations.length === 0 ||
      !operations.every((operation) => typeof operation === "string" && operation.length > 0) ||
      new Set(operations).size !== operations.length
    ) {
      return null
    }
  }

  return candidate as HostFeatureManifest
}
