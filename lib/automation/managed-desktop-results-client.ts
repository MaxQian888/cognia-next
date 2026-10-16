/** Private Host-owned results. There is deliberately no capture, execution or sharing API. */
import { useAccountStore } from "@/stores/account/account-store"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import {
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { isTauri } from "@/lib/utils"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { managedDesktopIdentityScope, type ManagedDesktopTarget } from "./managed-desktop-client"

export type ManagedDesktopAcceptanceOutcome = "passed" | "failed" | "inconclusive" | "cancelled"
export interface ManagedDesktopEvidenceArtifact {
  id: string
  criterionId: string
  kind: "checkpoint" | "failure"
  mimeType: string
  sha256: string
  bytes: number
  width: number
  height: number
  capturedAt: number
}
export interface ManagedDesktopAcceptanceResult {
  binding: {
    acceptanceId: string
    ownerAccountId: string
    hostId: string
    sourceId: string
    sessionId: string
    taskId: string
    parentRunId: string
    originRunRef?: string | null
    deliveryId: string
    deliveryRevision: number
    commit: string
    desktopId: string
    desktopGeneration: number
    manifestDigest: string
    criteria: Array<{ id: string; text: string; requiredEvidence: boolean }>
  }
  createdAt: number
  artifacts: ManagedDesktopEvidenceArtifact[]
  agentVerdict?: {
    input: {
      idempotencyKey: string
      principalId: string
      outcome: ManagedDesktopAcceptanceOutcome
      criteria: Array<{
        criterionId: string
        outcome: "passed" | "failed" | "incomplete"
        artifactIds: string[]
      }>
      summary: string
    }
    recordedAt: number
  } | null
  systemOutcome?: {
    outcome: ManagedDesktopAcceptanceOutcome
    reasonCode: string
    recordedAt: number
  } | null
  humanApprovals: Array<{
    revision: number
    input: {
      expectedRevision: number
      idempotencyKey: string
      principalId: string
      decision: "approved" | "rejected"
    }
    recordedAt: number
  }>
  cleanupPending: boolean
  evidenceLimitReached: boolean
  captureAttempts: number
  reservedBytes: number
}
export interface ManagedDesktopResultsFilter {
  runId?: string
  conversationId?: string
  taskId?: string
}
export interface ManagedDesktopEvidenceResponse {
  mimeType: string
  base64: string
  sha256: string
  cacheControl: "no-store"
}

/** One identity lifetime for both asynchronous calls and already-visible private previews. */
export function createManagedDesktopResultsScope(onInvalidated: () => void = () => undefined) {
  const owner = useAccountStore.getState().unlockedAccountId
  if (!owner || useAccountStore.getState().locked)
    throw new Error("managed_desktop_authentication_required")
  const remote = getActiveRemoteTransport()
  const native = isTauri()
  const local = native ? localTransport : transport
  const endpoint = remote ? getActiveRemoteEndpoint() : null
  let target: ManagedDesktopTarget
  if (remote) {
    if (!endpoint?.remoteHost?.id || endpoint.accountId !== owner)
      throw new Error("managed_desktop_session_invalidated")
    target = { kind: "remote", hostId: endpoint.remoteHost.id }
  } else if (native) {
    target = { kind: "local" }
  } else {
    const runtime = getActiveRuntimeTargetContext()
    if (!runtime || runtime.accountId !== owner)
      throw new Error("managed_desktop_session_invalidated")
    target = { kind: "remote", hostId: `companion:${runtime.targetId}` }
  }
  const endpointIdentity = () => {
    const value = remote ? getActiveRemoteEndpoint() : null
    return value
      ? JSON.stringify([
          value.remoteHost?.id,
          value.baseUrl,
          value.serverFingerprint,
          value.deviceId,
          value.deviceKeyThumbprint,
          value.accountId,
        ])
      : null
  }
  const endpointSnapshot = endpointIdentity()
  let invalidated = false
  const invalidate = () => {
    if (invalidated) return
    invalidated = true
    onInvalidated()
  }
  const identity = managedDesktopIdentityScope(target, invalidate)
  const assertActive = () => {
    identity.assertActive()
    // The active transport may still carry the previous pairing even when the
    // global Host row has already been replaced with the current account's row.
    if (endpoint) {
      const config = identity.hostConfig
        ? (JSON.parse(identity.hostConfig) as Record<string, unknown>)
        : null
      if (
        !config ||
        ["baseUrl", "deviceId", "deviceKeyThumbprint", "serverFingerprint", "accountId"].some(
          (key) => endpoint[key as keyof typeof endpoint] !== config[key]
        )
      )
        invalidate()
    }
    if (
      getActiveRemoteTransport() !== remote ||
      endpointIdentity() !== endpointSnapshot ||
      (!remote && !native && transport !== local)
    )
      invalidate()
    if (invalidated) throw new Error("managed_desktop_session_invalidated")
  }
  const detachRemote = subscribeActiveRemoteTransport(invalidate)
  const dispose = () => {
    invalidate()
    identity.dispose()
    detachRemote()
  }
  try {
    assertActive()
  } catch (error) {
    dispose()
    throw error
  }
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    assertActive()
    const value = remote
      ? await remote.call<T>(name, args)
      : native
        ? await local.call<T>("managed_desktop_local_call", { name, args })
        : await local.call<T>(name, args)
    assertActive()
    return value
  }
  return {
    owner,
    assertActive,
    list: (filter: ManagedDesktopResultsFilter) =>
      call<ManagedDesktopAcceptanceResult[]>("managed_desktop_results_get_results", {
        ...(filter.runId ? { runId: filter.runId } : {}),
        ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
        ...(filter.taskId ? { taskId: filter.taskId } : {}),
      }),
    get: (acceptanceId: string) =>
      call<ManagedDesktopAcceptanceResult>("managed_desktop_results_get_result", { acceptanceId }),
    readEvidence: (acceptanceId: string, artifactId: string) =>
      call<ManagedDesktopEvidenceResponse>("managed_desktop_results_read_evidence", {
        acceptanceId,
        artifactId,
      }),
    approve: (
      acceptanceId: string,
      expectedRevision: number,
      decision: "approved" | "rejected",
      idempotencyKey: string
    ) =>
      call<ManagedDesktopAcceptanceResult>("managed_desktop_results_approve", {
        acceptanceId,
        expectedRevision,
        decision,
        idempotencyKey,
      }),
    dispose,
  }
}

/** Decode only bounded, hash-matching private image bytes. The caller must revoke the URL. */
export async function managedDesktopEvidenceUrl(
  artifact: ManagedDesktopEvidenceArtifact,
  response: ManagedDesktopEvidenceResponse
): Promise<string> {
  if (
    response.cacheControl !== "no-store" ||
    !["image/png", "image/jpeg"].includes(response.mimeType) ||
    response.mimeType !== artifact.mimeType ||
    response.sha256 !== artifact.sha256 ||
    artifact.bytes <= 0 ||
    artifact.bytes > 8 * 1024 * 1024 ||
    response.base64.length > 11_184_812
  )
    throw new Error("managed_desktop_invalid_evidence")
  const binary = atob(response.base64)
  if (binary.length !== artifact.bytes) throw new Error("managed_desktop_invalid_evidence")
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  if (digest !== artifact.sha256) throw new Error("managed_desktop_invalid_evidence")
  return URL.createObjectURL(new Blob([bytes], { type: response.mimeType }))
}
