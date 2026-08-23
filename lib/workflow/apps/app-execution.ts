import type { WorkflowAppRelease, ResolvedWorkflowAppRelease } from "@/types/workflow/app"
import type { WorkflowEntrypoint } from "@/types/workflow/deployment"
import {
  executeDeployedWorkflow,
  type ExecuteDeployedWorkflowResult,
} from "@/lib/workflow/runtime/execution-authority"
import { emitWorkflowAppQuotaAlert } from "./alert-service"
import { assertWorkflowAppAdmissionQuota, WorkflowAppQuotaError } from "./quota-service"

export interface WorkflowAppRequestActor {
  authenticated: boolean
  /** Verified OIDC subject. Never populated from Dify-compatible `user`. */
  subjectId?: string
  groupIds?: string[]
  /** App-local external identity used for conversation/idempotency ownership only. */
  externalSubjectKey: string
  /** Present only for the Web Component / iframe surface. */
  embedOrigin?: string
  legalConsentGranted?: boolean
  /** Verified application service credential id; distinct from OIDC identity. */
  serviceCredentialId?: string
}

export class WorkflowAppAccessError extends Error {
  constructor(
    readonly code:
      | "authentication_required"
      | "group_denied"
      | "anonymous_disabled"
      | "embed_disabled"
      | "embed_origin_denied"
      | "legal_consent_required"
      | "invalid_subject",
    message: string
  ) {
    super(message)
    this.name = "WorkflowAppAccessError"
  }
}

export function authorizeWorkflowAppRequest(
  release: WorkflowAppRelease,
  actor: WorkflowAppRequestActor
): { caller: string } {
  if (!actor.externalSubjectKey.trim() || actor.externalSubjectKey.length > 256) {
    throw new WorkflowAppAccessError("invalid_subject", "An app-local subject key is required")
  }

  const access = release.snapshot.access
  if (actor.serviceCredentialId) {
    return { caller: `service:${actor.serviceCredentialId}` }
  }
  if (access.mode === "private" && !actor.authenticated) {
    throw new WorkflowAppAccessError("authentication_required", "This workflow app is private")
  }
  if (access.mode === "oidc") {
    if (!actor.authenticated || !actor.subjectId) {
      throw new WorkflowAppAccessError("authentication_required", "OIDC authentication is required")
    }
    const allowed = new Set(access.oidcGroupIds)
    if (allowed.size > 0 && !(actor.groupIds ?? []).some((groupId) => allowed.has(groupId))) {
      throw new WorkflowAppAccessError("group_denied", "The authenticated member is not allowed")
    }
  }
  if (access.mode !== "anonymous" && !actor.authenticated) {
    throw new WorkflowAppAccessError("anonymous_disabled", "Anonymous access is disabled")
  }

  if (actor.embedOrigin !== undefined) {
    if (!release.snapshot.embed.enabled) {
      throw new WorkflowAppAccessError("embed_disabled", "Embedding is disabled")
    }
    if (!release.snapshot.embed.allowedOrigins.includes(actor.embedOrigin)) {
      throw new WorkflowAppAccessError("embed_origin_denied", "The embedding origin is not allowed")
    }
  }
  if (release.snapshot.legal.requireConsent && !actor.legalConsentGranted) {
    throw new WorkflowAppAccessError(
      "legal_consent_required",
      "Legal consent is required for this release"
    )
  }

  return {
    caller:
      actor.authenticated && actor.subjectId
        ? `member:${actor.subjectId}`
        : `external:${actor.externalSubjectKey}`,
  }
}

export async function executePublishedWorkflowApp(input: {
  resolved: ResolvedWorkflowAppRelease
  actor: WorkflowAppRequestActor
  input: unknown
  idempotencyKey?: string
  entrypoint?: WorkflowEntrypoint
  signal?: AbortSignal
  onAdmitted?: (runId: string) => void
}): Promise<ExecuteDeployedWorkflowResult> {
  const authorization = authorizeWorkflowAppRequest(input.resolved.release, input.actor)
  const { app, release } = input.resolved
  try {
    return await executeDeployedWorkflow({
      workflowId: release.workflowId,
      entrypoint: input.entrypoint ?? "portal",
      caller: `app:${app.id}:release:${release.id}:${authorization.caller}`,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      authorizedScopes: ["workflow:run"],
      triggerKind: "trigger.manual",
      payload: { input: input.input, appId: app.id, appReleaseId: release.id },
      triggeredBy: {
        source: "api",
        initiator: {
          authenticated: input.actor.authenticated,
          externalSubjectKey: input.actor.externalSubjectKey,
          ...(input.actor.subjectId ? { principalId: input.actor.subjectId } : {}),
          ...(input.actor.groupIds ? { groupIds: input.actor.groupIds } : {}),
        },
      },
      lockedDependency: {
        workflowId: release.workflowId,
        versionId: release.versionId,
        deploymentId: release.deploymentId,
        deploymentRevision: release.deploymentRevision,
        dependencyLock: release.dependencyLock,
      },
      admissionCheck: ({ now }) =>
        assertWorkflowAppAdmissionQuota({
          appId: app.id,
          accountId: app.accountId,
          release,
          now,
        }),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onAdmitted ? { onAdmitted: input.onAdmitted } : {}),
    })
  } catch (error) {
    if (error instanceof WorkflowAppQuotaError) {
      await emitWorkflowAppQuotaAlert({ app, release, error })
    }
    throw error
  }
}
