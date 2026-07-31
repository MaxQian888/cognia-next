import { APP_VERSION } from "@/lib/app-version"
import type { Platform } from "./detect"

export const HOST_FEATURE_MANIFEST_SCHEMA_VERSION = 2 as const
export const DEFAULT_COMPANION_DEVICE_GRANTS = ["host.observe"] as const
export const HOST_PROTOCOL_MIN_VERSION = 1
export const HOST_PROTOCOL_MAX_VERSION = 2

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

export const SUPPORTED_HOST_FEATURE_VERSIONS: Readonly<Record<HostFeatureId, readonly number[]>> =
  Object.freeze(
    Object.fromEntries(HOST_FEATURE_IDS.map((feature) => [feature, Object.freeze([1])])) as Record<
      HostFeatureId,
      readonly number[]
    >
  )

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

interface HostFeatureManifestBase {
  hostBuildId: string
  platform: Platform
  generatedAt: number
  features: Partial<Record<HostFeatureId, HostFeatureDescriptor>>
  limits: HostFeatureLimits
}

export interface HostFeatureManifestV1 extends HostFeatureManifestBase {
  schemaVersion: 1
}

export interface HostRuntimeOperationDescriptor {
  name: string
  feature: HostFeatureId
  featureVersion: number
  healthy: boolean
}

export interface HostFeatureManifestV2 extends HostFeatureManifestBase {
  schemaVersion: 2
  hostIdentity: {
    id: string
    kind: "desktop" | "cloud"
  }
  protocol: {
    min: number
    max: number
  }
  operations: HostRuntimeOperationDescriptor[]
  deviceGrants: string[]
}

export type HostFeatureManifest = HostFeatureManifestV1 | HostFeatureManifestV2

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
  hostId = `local-${platform}`,
  deviceGrants = [...DEFAULT_COMPANION_DEVICE_GRANTS],
}: {
  hostBuildId?: string
  platform: Platform
  hostId?: string
  deviceGrants?: string[]
}): HostFeatureManifestV2 {
  const features: HostFeatureManifestV2["features"] = {
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
  }
  return {
    schemaVersion: HOST_FEATURE_MANIFEST_SCHEMA_VERSION,
    hostBuildId,
    platform,
    generatedAt: Date.now(),
    hostIdentity: {
      id: hostId,
      kind: platform === "headless" ? "cloud" : "desktop",
    },
    protocol: {
      min: HOST_PROTOCOL_MIN_VERSION,
      max: HOST_PROTOCOL_MAX_VERSION,
    },
    features,
    operations: Object.entries(features).flatMap(([feature, descriptor]) =>
      (descriptor?.operations ?? []).map((name) => ({
        name,
        feature: feature as HostFeatureId,
        featureVersion: descriptor!.version,
        healthy: true,
      }))
    ),
    deviceGrants: [...new Set(deviceGrants)],
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
  if (!SUPPORTED_HOST_FEATURE_VERSIONS[feature].includes(descriptor.version)) {
    return false
  }
  if (operation === undefined) return true
  if (!descriptor.operations.includes(operation)) return false
  if (manifest.schemaVersion === 1) return true
  return manifest.operations.some((candidate) => candidate.name === operation && candidate.healthy)
}

export function parseHostFeatureManifest(value: unknown): HostFeatureManifest | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<HostFeatureManifest>
  if (
    (candidate.schemaVersion !== 1 &&
      candidate.schemaVersion !== HOST_FEATURE_MANIFEST_SCHEMA_VERSION) ||
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

  if (candidate.schemaVersion === HOST_FEATURE_MANIFEST_SCHEMA_VERSION) {
    const v2 = candidate as Partial<HostFeatureManifestV2>
    const protocolMin = v2.protocol?.min
    const protocolMax = v2.protocol?.max
    if (
      !v2.hostIdentity ||
      typeof v2.hostIdentity.id !== "string" ||
      v2.hostIdentity.id.length === 0 ||
      !["desktop", "cloud"].includes(v2.hostIdentity.kind ?? "") ||
      typeof protocolMin !== "number" ||
      typeof protocolMax !== "number" ||
      !Number.isSafeInteger(protocolMin) ||
      !Number.isSafeInteger(protocolMax) ||
      protocolMin < 1 ||
      protocolMax < protocolMin ||
      !Array.isArray(v2.operations) ||
      !Array.isArray(v2.deviceGrants) ||
      !v2.deviceGrants.every((grant) => typeof grant === "string" && grant.length > 0) ||
      new Set(v2.deviceGrants).size !== v2.deviceGrants.length
    ) {
      return null
    }
    const declaredOperations = new Map<string, { feature: string; version: number }>()
    for (const [feature, descriptor] of Object.entries(v2.features ?? {})) {
      for (const operation of descriptor?.operations ?? []) {
        declaredOperations.set(operation, {
          feature,
          version: descriptor!.version,
        })
      }
    }
    if (
      v2.operations.some((operation) => {
        const declared = declaredOperations.get(operation.name)
        return (
          !declared ||
          operation.feature !== declared.feature ||
          operation.featureVersion !== declared.version ||
          typeof operation.healthy !== "boolean"
        )
      }) ||
      new Set(v2.operations.map((operation) => operation.name)).size !== v2.operations.length
    ) {
      return null
    }
  }

  return candidate as HostFeatureManifest
}
