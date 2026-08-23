import { getSharedLinkByCode } from "@/lib/db/shared-links"
import { resolvePublishedWorkflowApp } from "@/lib/db/workflow-apps"
import {
  createShareLink,
  revokeShareLink,
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
} from "@/lib/share/client"
import { sha256Hex } from "@/lib/share/hash"
import type { ResolvedWorkflowAppRelease } from "@/types/workflow/app"
import { authorizeWorkflowAppRequest, type WorkflowAppRequestActor } from "./app-execution"
import { getWorkflowAppRun } from "./app-api-service"

const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60

export class WorkflowResultSharingError extends Error {
  constructor(
    readonly code:
      | "app_not_found"
      | "result_sharing_disabled"
      | "invalid_share_ttl"
      | "share_not_found"
      | "share_service_unavailable"
      | "share_payload_too_large",
    message: string
  ) {
    super(message)
    this.name = "WorkflowResultSharingError"
  }
}

async function throughShareService<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof SharePayloadTooLargeError) {
      throw new WorkflowResultSharingError(
        "share_payload_too_large",
        "The workflow result is too large to share"
      )
    }
    if (error instanceof ShareNotConfiguredError || error instanceof ShareRequestError) {
      throw new WorkflowResultSharingError(
        "share_service_unavailable",
        "The result sharing service is unavailable"
      )
    }
    throw error
  }
}

async function publishedApp(
  accountId: string,
  appSlug: string
): Promise<ResolvedWorkflowAppRelease> {
  const resolved = await resolvePublishedWorkflowApp(accountId, appSlug)
  if (!resolved) {
    throw new WorkflowResultSharingError("app_not_found", "Published app was not found")
  }
  return resolved
}

async function ownerScope(
  resolved: ResolvedWorkflowAppRelease,
  actor: WorkflowAppRequestActor
): Promise<string> {
  const { caller } = authorizeWorkflowAppRequest(resolved.release, actor)
  return `workflow-result:${resolved.app.id}:${await sha256Hex(caller)}`
}

export async function createWorkflowResultShare(input: {
  accountId: string
  appSlug: string
  runId: string
  actor: WorkflowAppRequestActor
  ttlSeconds?: number
}) {
  const resolved = await publishedApp(input.accountId, input.appSlug)
  if (!resolved.release.snapshot.resultSharing.enabled) {
    throw new WorkflowResultSharingError(
      "result_sharing_disabled",
      "Result sharing is disabled for this release"
    )
  }
  const ttlSeconds =
    input.ttlSeconds ??
    resolved.release.snapshot.resultSharing.defaultTtlSeconds ??
    DEFAULT_SHARE_TTL_SECONDS
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_SHARE_TTL_SECONDS) {
    throw new WorkflowResultSharingError(
      "invalid_share_ttl",
      "Result shares must expire between 1 minute and 30 days"
    )
  }
  const run = await getWorkflowAppRun(input)
  const localized =
    resolved.release.snapshot.localized.en ?? resolved.release.snapshot.localized["zh-CN"]
  const scopedOwner = await ownerScope(resolved, input.actor)
  return throughShareService(() =>
    createShareLink({
      payload: {
        kind: "workflow-result",
        mime: "application/json",
        encoding: "utf8",
        title: localized?.title ?? resolved.app.slug,
        data: JSON.stringify({
          schemaVersion: 1,
          app: { slug: resolved.app.slug, kind: resolved.app.kind },
          releaseId: resolved.release.id,
          run,
        }),
      },
      ttlSeconds,
      ownerScope: scopedOwner,
    })
  )
}

export async function revokeWorkflowResultShare(input: {
  accountId: string
  appSlug: string
  code: string
  actor: WorkflowAppRequestActor
}): Promise<void> {
  const resolved = await publishedApp(input.accountId, input.appSlug)
  const [row, expectedOwnerScope] = await Promise.all([
    getSharedLinkByCode(input.code),
    ownerScope(resolved, input.actor),
  ])
  if (!row || row.kind !== "workflow-result" || row.ownerScope !== expectedOwnerScope) {
    throw new WorkflowResultSharingError("share_not_found", "Result share was not found")
  }
  await throughShareService(() => revokeShareLink(input.code))
}
