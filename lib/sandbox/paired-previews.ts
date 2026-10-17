/**
 * Paired-desktop half of ADR-0231 phase 2 previews.
 *
 * The Host owner shares one preview grant with one paired device. The grant is
 * served on the Host's `/api/sandbox/previews/<id>/` device route, which
 * admits only that device's own bearer + DPoP credentials. A browser cannot
 * attach those, so this desktop opens the grant through the same native
 * loopback relay as forwarded environment ports: it pins the Host certificate
 * and signs every proxied request, and the system browser only ever sees
 * `http://127.0.0.1:<port>/`. Nothing listed here is a credential.
 */
import {
  ensureRemotePortRelay,
  remoteEndpointCompanionConfig,
  stopRemotePortRelay,
  type DesktopRelayStatus,
} from "@/lib/codeserver/remote-relay"
import { companionAuthorizationHeaders, type AuthFetcher } from "@/lib/tauri/companion-auth"
import { pinnedFetch } from "@/lib/tauri/pinned-fetch"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"
import type { PairedPreviewSummary } from "./previews"

export const SHARED_PREVIEWS_PATH = "/api/sandbox/previews"
const GRANT_ID = /^[0-9a-f]{32}$/

/** The Host answered the list with a non-2xx status (403: control was revoked). */
export class SharedPreviewsError extends Error {
  constructor(readonly status: number) {
    super(`the Host refused the shared preview list (${status})`)
    this.name = "SharedPreviewsError"
  }
}

export function sharedPreviewRelayPath(id: string): string {
  if (!GRANT_ID.test(id)) throw new Error("preview_grant_id_invalid")
  return `${SHARED_PREVIEWS_PATH}/${id}/`
}

export function sharedPreviewRelayId(id: string): string {
  return `sandbox-preview:${id}`
}

function summary(value: unknown): PairedPreviewSummary | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (
    typeof row.id !== "string" ||
    !GRANT_ID.test(row.id) ||
    typeof row.projectId !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.resolvedPort !== "number" ||
    typeof row.expiresAt !== "number" ||
    row.relayPath !== sharedPreviewRelayPath(row.id)
  )
    return null
  return {
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    resolvedPort: row.resolvedPort,
    expiresAt: row.expiresAt,
    relayPath: row.relayPath,
  }
}

/** Live grants the Host shares with this paired device, for every project. */
export async function listSharedPreviews(
  endpoint: RemoteHostEndpoint,
  fetcher: AuthFetcher = pinnedFetch
): Promise<PairedPreviewSummary[]> {
  if (!endpoint.serverFingerprint) {
    throw new Error("remote host is missing its paired certificate fingerprint")
  }
  const headers = await companionAuthorizationHeaders(
    remoteEndpointCompanionConfig(endpoint),
    "GET",
    SHARED_PREVIEWS_PATH,
    fetcher
  )
  const response = await fetcher(`${endpoint.baseUrl.replace(/\/+$/, "")}${SHARED_PREVIEWS_PATH}`, {
    method: "GET",
    headers: { ...headers, Accept: "application/json" },
    serverFingerprint: endpoint.serverFingerprint,
  })
  if (!response.ok) throw new SharedPreviewsError(response.status)
  const body = (await response.json()) as { items?: unknown }
  if (!Array.isArray(body.items)) throw new Error("preview_list_malformed")
  // A row that does not name its own device route is dropped, not repaired:
  // the native relay would refuse it anyway.
  return body.items.flatMap((item) => {
    const row = summary(item)
    return row ? [row] : []
  })
}

/** Bind (or refresh) the loopback relay for one shared grant. */
export function openSharedPreview(
  endpoint: RemoteHostEndpoint,
  preview: Pick<PairedPreviewSummary, "id">
): Promise<DesktopRelayStatus> {
  return ensureRemotePortRelay(
    endpoint,
    sharedPreviewRelayPath(preview.id),
    sharedPreviewRelayId(preview.id)
  )
}

export function closeSharedPreview(id: string): Promise<void> {
  return stopRemotePortRelay(sharedPreviewRelayId(id))
}
