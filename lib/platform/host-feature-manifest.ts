import { APP_VERSION } from "@/lib/app-version"
import { getCommandManifest } from "@/lib/tauri/command-descriptors"
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
  "automation.hitl",
  "secrets.store",
  "browser.remote",
  "ocr.server",
  "notifications.remote",
  "workspace.files",
  "source-control.git",
  "twin.runtime",
  "session.state-sync",
  "connectors.inbox-relay",
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
  maxHostStateSnapshotBytes?: number
  maxHostStateActionBatch?: number
  maxPendingHostStateActions?: number
  hostStateReplayRetentionMs?: number
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
  reason?: string
}

export type HostOperationHealth = boolean | { healthy: boolean; reason?: string }

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
  transportCapabilities?: {
    /** Server emits `stream_ready` after replay and before live events. */
    eventStreamReady: 1
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
  maxHostStateSnapshotBytes: 512 * 1024,
  maxHostStateActionBatch: 50,
  maxPendingHostStateActions: 1000,
  hostStateReplayRetentionMs: 24 * 60 * 60 * 1000,
})

/**
 * ADR-0131 cross-shell inbox relay. A thin client (mobile / web companion /
 * desktop driving this host) that sees this feature may relay Inbox writes
 * through the four RPCs, expects the two realtime channels, and can mirror
 * the two extra companion-sync tables. Absence = pre-relay host: the client
 * shows `StateCard.RequiresHost` / disables Send instead of dead-lettering
 * queue rows. Advertised by every connector host (tauri + headless) because
 * the arms carry no host gate — `lib/companion/desktop-write-source.ts` runs
 * the same `lib/connectors/inbox-writes/local.ts` code on both.
 */
export const INBOX_RELAY_HOST_OPERATIONS = Object.freeze([
  "connector_enqueue_outbound",
  "connector_approve_draft",
  "connector_reject_draft",
  "conversation_overrides_update",
  "event:sync://invalidate",
  "event:connector://message-added",
  "sync:connectorDrafts",
  "sync:outboundQueue",
] as const)

/** Git operations implemented by the remote execution host (native watchers remain client-local). */
export const SOURCE_CONTROL_HOST_OPERATIONS = Object.freeze(
  getCommandManifest()
    .commands.filter((command) => command.name.startsWith("git_") && command.target === "execution")
    .map((command) => command.name)
)

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
  operationHealth = {},
}: {
  hostBuildId?: string
  platform: Platform
  hostId?: string
  deviceGrants?: string[]
  operationHealth?: Readonly<Record<string, HostOperationHealth>>
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
  if (platform === "tauri") {
    features["automation.hitl"] = {
      version: 1,
      operations: ["automation_consent_pending", "automation_consent_respond"],
    }
  }
  if (platform === "tauri" || platform === "headless") {
    // The git arms carry no host gate; what used to keep this desktop-only was
    // the workspace registrar — the desktop resolves `workspaceId` through the
    // roots its renderer registers, while the headless host resolves it as a
    // directory under its policy-owned workspaces root (the same boundary as
    // `workspace.files`). Both hosts now answer every remote git operation.
    features["source-control.git"] = {
      version: 1,
      operations: [...SOURCE_CONTROL_HOST_OPERATIONS, "host_admin_lease_issue"],
    }
    features["session.state-sync"] = {
      version: 1,
      operations: ["host_state_snapshot", "host_state_submit", "host_state_status"],
    }
    features["twin.runtime"] = {
      version: 1,
      operations: ["twin_draft_review"],
    }
    features["connectors.inbox-relay"] = {
      version: 1,
      operations: [...INBOX_RELAY_HOST_OPERATIONS],
    }
    features["notifications.remote"] = {
      version: 1,
      operations: [
        "register_push_token",
        "revoke_push_token",
        ...(platform === "headless" ? ["remote_notification_publish"] : []),
        ...(platform === "headless" ? ["event:notification://remote"] : []),
        ...(platform === "tauri" ? ["event:automation:consent-request"] : []),
        "event:workflow://approval-request",
        "event:workflow://approval-resolved",
        "event:workflow://step-execute",
        "event:ocr://download-progress",
      ],
    }
    features["workspace.files"] = {
      version: 1,
      operations: [
        "fs_search_workspace",
        "fs_search_content_workspace",
        "fs_read_workspace_file",
        "fs_write_workspace_file",
        "fs_list_workspace_dir",
        "fs_stat_workspace_file",
        "fs_create_workspace_dir",
        "fs_delete_workspace_entry",
        "fs_rename_workspace_entry",
        "fs_copy_workspace_entry",
      ],
    }
  }
  if (platform === "headless") {
    features["secrets.store"] = {
      version: 1,
      operations: ["secret_store_get", "secret_store_set", "secret_store_delete"],
    }
    features["browser.remote"] = {
      version: 1,
      operations: [
        "browser_runtime_status",
        "browser_capability",
        "browser_session_ensure",
        "browser_session_get",
        "browser_session_close",
        "browser_navigate",
        "browser_snapshot",
        "browser_act",
        "browser_press_key",
        "browser_scroll",
        "browser_evaluate",
        "browser_read_console",
        "browser_read_network",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "browser_stop",
        "browser_get_page",
        "browser_pages",
        "browser_switch_page",
        "browser_close_page",
        "browser_wait_for",
        "browser_wait_for_load",
        "browser_screenshot",
        "browser_set_files",
        "browser_downloads",
        "browser_set_zoom",
        "browser_find",
        "browser_find_clear",
      ],
    }
  }
  if (platform === "tauri" || platform === "headless") {
    features["ocr.server"] = {
      version: 1,
      operations: [
        "ocr_list_native_backends",
        "ocr_list_available_backends",
        "ocr_extract_native",
        "ocr_model_status",
        "ocr_download_model",
        "ocr_cancel_model_download",
      ],
    }
  }
  const healthFor = (name: string): { healthy: boolean; reason?: string } => {
    const health = operationHealth[name]
    if (typeof health === "boolean") return { healthy: health }
    return health ?? { healthy: true }
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
    transportCapabilities: {
      eventStreamReady: 1,
    },
    features,
    operations: Object.entries(features).flatMap(([feature, descriptor]) =>
      (descriptor?.operations ?? []).map((name) => {
        const health = healthFor(name)
        return {
          name,
          feature: feature as HostFeatureId,
          featureVersion: descriptor!.version,
          healthy: health.healthy,
          ...(health.reason ? { reason: health.reason } : {}),
        }
      })
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
  if (
    [
      limits.maxHostStateSnapshotBytes,
      limits.maxHostStateActionBatch,
      limits.maxPendingHostStateActions,
      limits.hostStateReplayRetentionMs,
    ].some(
      (limit) =>
        limit !== undefined &&
        (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    )
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
    const transportCapabilities = v2.transportCapabilities
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
      (transportCapabilities !== undefined &&
        (!transportCapabilities ||
          typeof transportCapabilities !== "object" ||
          transportCapabilities.eventStreamReady !== 1)) ||
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
      v2.operations.length !== declaredOperations.size ||
      v2.operations.some((operation) => {
        if (!operation || typeof operation !== "object") return true
        const declared = declaredOperations.get(operation.name)
        return (
          typeof operation.name !== "string" ||
          !declared ||
          operation.feature !== declared.feature ||
          operation.featureVersion !== declared.version ||
          typeof operation.healthy !== "boolean" ||
          (operation.reason !== undefined &&
            (typeof operation.reason !== "string" || operation.reason.length === 0))
        )
      }) ||
      new Set(v2.operations.map((operation) => operation.name)).size !== v2.operations.length
    ) {
      return null
    }
  }

  return candidate as HostFeatureManifest
}
