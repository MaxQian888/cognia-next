"use client"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { loadLogtoSession } from "@/lib/logto/session-store"
import { createPlatformFetch } from "@/lib/network/platform-fetch"

import {
  CollabClient,
  type AppendCollabIssueEventInput,
  type CreateCollabIssueInput,
  type CreateCollabPlanInput,
  type CreateCollabRunInput,
  type PatchCollabIssueInput,
  type PatchCollabPlanInput,
  type PatchCollabRunInput,
} from "./client"
import { loadCollabConnection } from "./connection"
import { requestCollabRefresh } from "./refresh-scheduler"

export const COLLAB_OUTBOUND_COMMANDS = [
  "collab_issue_create",
  "collab_issue_patch",
  "collab_issue_append_event",
  "collab_plan_create",
  "collab_plan_patch",
  "collab_run_create",
  "collab_run_patch",
] as const

export type CollabOutboundDispatchCommand = (typeof COLLAB_OUTBOUND_COMMANDS)[number]

export interface CollabOutboundDispatcherDeps {
  localAccountId?: string
  client?: CollabClient
  refresh?: (localAccountId: string) => Promise<unknown>
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || !value) throw new Error(`collab queue payload needs ${key}`)
  return value
}

function withoutRouting(payload: Record<string, unknown>): Record<string, unknown> {
  const { orgId: _orgId, issueId: _issueId, planId: _planId, runId: _runId, ...body } = payload
  return body
}

export async function dispatchCollabOutbound(
  command: CollabOutboundDispatchCommand,
  payload: Record<string, unknown>,
  deps: CollabOutboundDispatcherDeps = {}
): Promise<unknown> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const orgId = requiredString(payload, "orgId")
  const connection = loadCollabConnection(localAccountId)
  if (!connection && !deps.client) throw new Error("collaboration plane is not configured")
  const client =
    deps.client ??
    new CollabClient({
      baseUrl: connection?.baseUrl ?? "",
      accessToken: async () => (await loadLogtoSession(localAccountId))?.accessToken ?? null,
      fetchImpl: createPlatformFetch(),
    })
  const body = withoutRouting(payload)

  let result: unknown
  switch (command) {
    case "collab_issue_create":
      result = await client.createIssue(orgId, body as CreateCollabIssueInput)
      break
    case "collab_issue_patch":
      result = await client.patchIssue(
        orgId,
        requiredString(payload, "issueId"),
        body as PatchCollabIssueInput
      )
      break
    case "collab_issue_append_event":
      result = await client.appendIssueEvent(
        orgId,
        requiredString(payload, "issueId"),
        body as AppendCollabIssueEventInput
      )
      break
    case "collab_plan_create":
      result = await client.createPlan(orgId, body as CreateCollabPlanInput)
      break
    case "collab_plan_patch":
      result = await client.patchPlan(
        orgId,
        requiredString(payload, "planId"),
        body as PatchCollabPlanInput
      )
      break
    case "collab_run_create":
      result = await client.createRun(orgId, body as CreateCollabRunInput)
      break
    case "collab_run_patch":
      result = await client.patchRun(
        orgId,
        requiredString(payload, "runId"),
        body as PatchCollabRunInput
      )
      break
    default:
      // `liveDispatcher` selects this dispatcher by name prefix and calls it
      // through `as never`, so exhaustiveness here is not enforced at the call
      // site. Without this arm an unlisted `collab_` command left `result`
      // undefined, the drain read that as success and marked the row sent, and
      // the edit was lost with nothing to show for it. Throwing puts the row
      // on the normal retry-then-deadletter path, where it is visible.
      throw new Error(`collab queue command ${String(command)} has no dispatch route`)
  }

  // Fire-and-forget through the scheduler's coalescing entry point. Awaiting a
  // fresh pull per mutation made a drain of N queued edits issue N full
  // four-leg refreshes back to back; `requestCollabRefresh` returns the
  // in-flight promise instead, so a burst collapses into one.
  void (deps.refresh ?? ((id) => requestCollabRefresh(id)))(localAccountId)?.catch?.(() => {})
  return result
}
