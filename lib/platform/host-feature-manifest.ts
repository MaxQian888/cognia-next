import { getDocumentAcceptExtensions } from "@cognia/document/support-matrix"
import { APP_VERSION } from "@/lib/app-version"
import {
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
} from "@/lib/chat/attachments/prepare"
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
  "session.remote-control",
  "session.attachment-upload",
  "session.thread-handoff",
  "connectors.inbox-relay",
  "workflow.execution",
  // Host-owned external-agent configurations. Its presence is what tells a
  // browser that this host can BE the authority for an external agent — that
  // it holds the head/revision store, not just a process it was handed a
  // config blob for. A client that cannot see this feature must not offer
  // remote external agents at all; falling back to sending a whole config per
  // turn is exactly the arrangement the store exists to replace.
  "external-agent.host-configs",
  // Pro IDE (ADR-0088). Its presence is what tells a companion that this host
  // can run a workbench at all, which nothing could discover before: the five
  // lifecycle commands were reachable over the wire while the manifest said
  // nothing about them, so a client had to call and see. Declared only after
  // the agent-drive verbs became `target: "execution"`, per the rule at the
  // bottom of this file: transport, authorization and dispatch first, feature
  // second.
  "pro-ide",
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
  /** Ceiling for one attachment. */
  attachmentMaxBytes?: number
  /** How many attachments one message may carry. */
  attachmentMaxPerMessage?: number
  /**
   * What the Host will accept, in `<input accept>` form (`image/*` plus the
   * document extensions `lib/document` can extract).
   *
   * Published rather than assumed so a mobile plus-menu can hide the entries
   * this Host cannot take — a camera button that stages a HEIC the Host refuses
   * is worse than no camera button, because the refusal arrives after the user
   * has already chosen the photo.
   */
  attachmentAcceptTypes?: string[]
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
  /**
   * The scope the Host's own host-state actually lives under.
   *
   * `hostIdentity.id` is the id the *device* asserted and the Host echoed
   * back — it names the pairing, not the state. The Host stores every
   * host-state channel under its own active runtime target
   * (`cognia://target/<runtimeTargetId>/sessions/...`), which on a Host
   * serving other devices is its local runtime (`local-host`), never the
   * `hostId` the client files it under in its own registry. A client that
   * addresses host-state by its own id is asking for a namespace the Host
   * has never written to, and every `host_state_*` call is refused with
   * `host_state_scope_mismatch`.
   *
   * Optional because a Host older than this field cannot declare it; a
   * client that sees no declaration keeps its previous behaviour.
   */
  hostStateScope?: {
    accountId: string
    runtimeTargetId: string
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
  attachmentMaxBytes: COMPOSER_MAX_ATTACHMENT_BYTES,
  attachmentMaxPerMessage: COMPOSER_MAX_ATTACHMENTS,
  attachmentAcceptTypes: ["image/*", ...getDocumentAcceptExtensions("chat")],
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
  hostStateScope,
  deviceGrants = [...DEFAULT_COMPANION_DEVICE_GRANTS],
  operationHealth = {},
}: {
  hostBuildId?: string
  platform: Platform
  hostId?: string
  hostStateScope?: { accountId: string; runtimeTargetId: string }
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
    features["workflow.execution"] = {
      version: 1,
      operations: [
        "workflow_placement_probe",
        "workflow_handoff_create",
        "workflow_run_list",
        "workflow_cancel_run",
      ],
    }
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
    // Advertised on both hosts that can actually spawn a process. The
    // operations are named individually rather than implied by the feature id
    // so a host that ships the store but not yet the reconcile command is
    // describable — `supportsHostFeatureOperation` is per-operation for
    // exactly this reason.
    features["external-agent.host-configs"] = {
      version: 1,
      operations: [
        "external_agent_config_list",
        "external_agent_config_get",
        "external_agent_config_create",
        "external_agent_config_update",
        "external_agent_config_delete",
        "external_agent_config_reconcile",
        // Admission is part of the same feature rather than its own: a host
        // that stores configurations but cannot admit a run against one is not
        // usefully different from a host that has neither, and splitting them
        // would let a client believe it had found a runnable target.
        "external_agent_admit_run",
        "external_agent_release_run",
        // The run plane itself. Named here so a client can gate on it: a host
        // that shipped the store before the run commands would otherwise
        // answer a turn with a raw "unknown command" instead of the structured
        // "this host is too old" every sibling operation gets.
        "external_agent_run_turn",
        "external_agent_cancel_run",
        "external_agent_resolve_decision",
      ],
    }
    // Lease-backed attach. Its presence is what tells a client that
    // `session_attach` understands `mode`, binds the attachment to a real
    // event-plane lease, and answers with the mode it granted plus the
    // `supportedActions` this caller may submit. Without it the client is
    // talking to a Host whose attach is an unbounded registration: it must
    // assume control (the old implicit behaviour) and cannot show why it was
    // refused, because nothing tells it.
    // The workbench lifecycle plus the agent-drive verbs, named individually
    // because a host can legitimately have one without the other: an older
    // build answers `codeserver_ensure` and refuses every `codeserver_agent_*`,
    // and a client that assumed the whole set from the feature id would show
    // an editor toolbar whose buttons do nothing.
    features["pro-ide"] = {
      version: 1,
      operations: [
        "codeserver_supported",
        "codeserver_ensure",
        "codeserver_status",
        "codeserver_stop",
        "codeserver_stop_all",
        "codeserver_open_file",
        "codeserver_agent_open",
        "codeserver_agent_apply_edit",
        "codeserver_agent_read_active",
        "codeserver_agent_save_all",
        "codeserver_agent_show_diff",
        "codeserver_agent_reveal",
        "codeserver_agent_run_in_terminal",
        "codeserver_agent_notify",
        "codeserver_agent_workspace_snapshot",
        "codeserver_read_user_settings",
        "codeserver_write_user_settings",
        "codeserver_read_runtime_args",
        "codeserver_write_runtime_args",
      ],
    }
    features["session.remote-control"] = {
      version: 1,
      operations: ["session_attach", "session_detach"],
    }
    // Chunked attachment upload. Its presence is what tells a client it may
    // stage a file at all: without it `message.enqueue` reaches a Host that
    // carries the refs into a prompt it cannot resolve, so the model is told
    // about a screenshot it never sees. The client shows the paperclip only
    // when this feature is advertised, and sizes its chunks from `limits`.
    features["session.attachment-upload"] = {
      version: 1,
      operations: [
        "session_attachment_upload_init",
        "session_attachment_upload_chunk",
        "session_attachment_upload_commit",
        "session_attachment_upload_abort",
      ],
    }
    features["session.thread-handoff"] = {
      version: 1,
      operations: [
        "thread_handoff_offer",
        "thread_handoff_preflight",
        "thread_handoff_accept",
        "thread_handoff_commit",
        "thread_handoff_abort",
        "thread_handoff_status",
      ],
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
    ...(hostStateScope ? { hostStateScope } : {}),
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
      (v2.hostStateScope !== undefined &&
        (!v2.hostStateScope ||
          typeof v2.hostStateScope !== "object" ||
          typeof v2.hostStateScope.accountId !== "string" ||
          v2.hostStateScope.accountId.length === 0 ||
          typeof v2.hostStateScope.runtimeTargetId !== "string" ||
          v2.hostStateScope.runtimeTargetId.length === 0)) ||
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
