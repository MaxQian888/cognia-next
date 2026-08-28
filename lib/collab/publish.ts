/** Explicit, allowlisted publication boundaries for local plans and runs. */

import type { AgentPlan } from "@/types/agent/plan"
import type { IssueRun } from "@/types/issues"

import { enqueueCollabMutation } from "@/lib/db/mobile-outbound-queue"

export interface CollabPublishTarget {
  orgId: string
  workspaceId: string
}

function webArtifacts(run: IssueRun): Array<{ label: string; href: string }> {
  return run.artifacts.flatMap((artifact) => {
    if (!artifact.label.trim()) return []
    try {
      const url = new URL(artifact.href)
      return url.protocol === "http:" || url.protocol === "https:"
        ? [{ label: artifact.label, href: url.toString() }]
        : []
    } catch {
      return []
    }
  })
}

/**
 * Publish the readable plan projection only. Execution params, prompts, tool
 * inputs, paths, runtime ids, metadata and generation guards never cross this
 * boundary.
 */
export async function publishPlanToCollab(
  plan: AgentPlan,
  target: CollabPublishTarget
): Promise<void> {
  await enqueueCollabMutation({
    command: "collab_plan_create",
    orgId: target.orgId,
    entityType: "plan",
    entityId: plan.id,
    payload: {
      workspaceId: target.workspaceId,
      title: plan.title,
      ...(plan.description ? { description: plan.description } : {}),
      status: plan.status,
      steps: [...plan.steps]
        .sort((left, right) => left.order - right.order)
        .map((step) => ({
          title: step.title,
          ...(step.description ? { description: step.description } : {}),
          kind: step.kind,
          status: step.status,
        })),
    },
  })
}

/** Publish a run summary without engine-native handles or local-only links. */
export async function publishRunToCollab(
  run: IssueRun,
  title: string,
  target: CollabPublishTarget
): Promise<void> {
  await enqueueCollabMutation({
    command: "collab_run_create",
    orgId: target.orgId,
    entityType: "run",
    entityId: run.id,
    payload: {
      workspaceId: target.workspaceId,
      title,
      kind: run.kind,
      status: run.status,
      artifacts: webArtifacts(run),
    },
  })
}
