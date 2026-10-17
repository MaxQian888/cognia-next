/** Metadata-only Phase 3 proposal API. It has no billed creation or execution method. */
import { localTransport } from "@/lib/tauri/transport-instance"
import { withManagementChannel } from "@/lib/remote-host/management-channel"
import {
  managedDesktopIdentityScope,
  type ManagedDesktopQuote,
  type ManagedDesktopTarget,
} from "./managed-desktop-client"

export type ManagedDesktopHandoffMode = "commit" | "bundle"

/** Unsupported transfer/automation modes remain dormant at the contract boundary. */
export const MANAGED_DESKTOP_HANDOFF_CAPABILITIES = {
  productionExecution: false,
  livePreview: false,
  crossHost: false,
  projectAutomaticAcceptance: false,
} as const

export interface ManagedDesktopDeliverySummary {
  id: string
  revision: number
  commit: string
  branch: string
  modes: ManagedDesktopHandoffMode[]
  createdAt: number
}

export interface ManagedDesktopHandoffRequest {
  deliveryId: string
  deliveryRevision: number
  mode: ManagedDesktopHandoffMode
  providerConfigId: string
  lifetimeSeconds: number
  criteria: string[]
  /** Explicit repository-relative files only; Host validates and hashes their contents. */
  acceptanceFiles: string[]
  /** Executed at the repository root by the future qualified executor, never a shell string. */
  argv: string[]
}

export interface ManagedDesktopHandoffProposal {
  id: string
  deliveryId: string
  deliveryRevision: number
  mode: ManagedDesktopHandoffMode
  commit: string
  quote: ManagedDesktopQuote
  expiresAt: number
  executionEnabled: false
  dormantReason: "managed_desktop_handoff_requires_results_qualification"
}

async function call<T>(
  target: ManagedDesktopTarget,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  if (target.kind === "remote" && !target.hostId.trim())
    throw new Error("managed_desktop_host_required")
  const identity = managedDesktopIdentityScope(target)
  try {
    // Capture and subscribe before acquisition, including re-pair A → B → A.
    identity.assertActive()
    if (target.kind === "local") {
      const result = await localTransport.call<T>("managed_desktop_local_call", { name, args })
      identity.assertActive()
      return result
    }
    return await withManagementChannel(target.hostId, async (channel) => {
      identity.assertChannel(channel.host.config)
      const result = await channel.transport.call<T>(name, args)
      identity.assertActive()
      return result
    })
  } finally {
    identity.dispose()
  }
}

export const managedDesktopHandoffClient = {
  deliveries: (target: ManagedDesktopTarget) =>
    call<ManagedDesktopDeliverySummary[]>(target, "managed_desktop_handoff_deliveries", {}),
  prepare: (target: ManagedDesktopTarget, request: ManagedDesktopHandoffRequest) =>
    call<ManagedDesktopHandoffProposal>(target, "managed_desktop_handoff_prepare", {
      deliveryId: request.deliveryId,
      deliveryRevision: request.deliveryRevision,
      mode: request.mode,
      providerConfigId: request.providerConfigId,
      lifetimeSeconds: request.lifetimeSeconds,
      criteria: request.criteria,
      acceptanceFiles: request.acceptanceFiles,
      argv: request.argv,
    }),
}

/** Suppress paths, provider responses, credentials and arbitrary backend text. */
export function managedDesktopHandoffErrorKey(error: unknown): string {
  const value =
    typeof error === "string" ? error : error instanceof Error ? error.message : undefined
  switch (value) {
    case "managed_desktop_handoff_source_unavailable":
    case "managed_desktop_handoff_source_changed":
    case "managed_desktop_handoff_provenance_required":
      return "sourceUnavailable"
    case "managed_desktop_authentication_required":
    case "managed_desktop_session_invalidated":
      return "identityChanged"
    default:
      return "prepareFailed"
  }
}
