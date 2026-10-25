/**
 * Gather what `planActionReview` needs for one run (ADR-0239).
 *
 * - **Origin**: the root session, the instruction epoch and the origin thread.
 *   A session-backed run reads them with `resolveSessionRequestOrigin`; a
 *   scheduled task or a Bot installation carries its own
 *   ({@link taskPlanOrigin}, {@link botPlanOrigin}).
 * - **Fence and instruction grants**: the `deny|…` and `grant|…` keys of
 *   unexpired receipts in that root and epoch, one indexed prefix query each.
 *   A run whose origin lacks a root or an epoch has neither, so nothing is
 *   fenced and nothing is granted for the instruction: it can only ask.
 * - **Policy grants**: recipient lists a person configured, passed in by the
 *   caller from the lists in `configured-grants.ts` (a Bot installation's, a
 *   connector instance's, a conversation's proactive-push opt-in). A delivery
 *   outside the origin thread that no list grants drafts or parks.
 * - **Mode**: `agentPermissions.outboundAuthorization`, `shadow` unless it is
 *   exactly `enforce` (`readOutboundAuthorizationMode`), read from the app's
 *   settings store by default ({@link readAppSettings}). Only the Settings →
 *   Security card writes it.
 */

import {
  actionReviewAuthKeyPrefix,
  listActionReviewAuthKeys,
  type ActionReviewAuthKeyKind,
} from "@/lib/db/action-review-receipts"
import type { ScheduledTaskPayload } from "@/types/scheduler"

import { conversationTarget, outboundFingerprint, type OutboundTarget } from "./outbound-targets"
import {
  readOutboundAuthorizationMode,
  type ActionReviewPlanContext,
  type OutboundReviewVia,
} from "./policy"
import { botInstructionEpoch, taskInstructionEpoch, taskOriginThread } from "./request-origin"

/** App settings as the engine reads them: only `agentPermissions.outboundAuthorization`. */
export type OutboundSettingsLike = { agentPermissions?: unknown } | null | undefined

/** The settings store's current settings; `null`, so shadow mode, in a shell without one. */
export async function readAppSettings(): Promise<OutboundSettingsLike> {
  try {
    const { useSettingsStore } = await import("@/stores/settings")
    return useSettingsStore.getState().settings
  } catch {
    return null
  }
}

/** Where a run's request came from, as the engine keys its fence and grants. */
export interface ActionReviewPlanOrigin {
  rootSessionId?: string
  instructionEpoch?: string
  originThread?: OutboundTarget
}

/** One configured recipient list: who wrote it (`bot:<id>`, `adapter:<id>`) and its targets. */
export interface OutboundPolicyGrantList {
  policyRef: string
  fingerprints: Iterable<string>
}

export interface BuildActionReviewPlanContextArgs {
  origin: ActionReviewPlanOrigin
  unattended: boolean
  via: OutboundReviewVia
  /** App settings; only `agentPermissions.outboundAuthorization` is read. */
  settings?: { agentPermissions?: unknown } | null
  policyGrants?: readonly OutboundPolicyGrantList[]
  now?: number
  /** Test seam for the receipt query. */
  listAuthKeys?: (prefix: string, now: number) => Promise<string[]>
}

/** The origin of a scheduled task's sessionless run: one root per task. */
export function taskPlanOrigin(task: {
  id: string
  humanRevision?: number
  payload?: ScheduledTaskPayload
}): ActionReviewPlanOrigin {
  const originThread = taskOriginThread(task)
  return {
    rootSessionId: `task:${task.id}`,
    instructionEpoch: taskInstructionEpoch(task),
    ...(originThread ? { originThread } : {}),
  }
}

/**
 * The origin of a Bot installation's run. A Bot has no origin thread: what it
 * may deliver to unattended is its configured recipient list.
 */
export function botPlanOrigin(installation: {
  id: string
  humanRevision?: number
}): ActionReviewPlanOrigin {
  return {
    rootSessionId: `bot:${installation.id}`,
    instructionEpoch: botInstructionEpoch(installation),
  }
}

/**
 * The origin of a workflow run: one root and one epoch per run, and the IM
 * conversation that triggered it, if one did, as its origin thread. A run
 * started anywhere else has no origin thread, so each of its unattended
 * deliveries needs a `policy` grant.
 */
export function workflowRunPlanOrigin(run: {
  id: string
  triggeredBy?: { conversationKey?: string }
}): ActionReviewPlanOrigin {
  const key = run.triggeredBy?.conversationKey
  const originThread = key ? conversationTarget(key) : undefined
  return {
    rootSessionId: `workflow-run:${run.id}`,
    instructionEpoch: `workflow-run:${run.id}`,
    ...(originThread ? { originThread } : {}),
  }
}

async function fingerprintsFor(
  kind: ActionReviewAuthKeyKind,
  origin: ActionReviewPlanOrigin,
  now: number,
  listAuthKeys: (prefix: string, now: number) => Promise<string[]>
): Promise<Set<string>> {
  if (!origin.rootSessionId || !origin.instructionEpoch) return new Set()
  const prefix = actionReviewAuthKeyPrefix(kind, origin.rootSessionId, origin.instructionEpoch)
  const keys = await listAuthKeys(prefix, now)
  return new Set(keys.map((key) => key.slice(prefix.length)))
}

export async function buildActionReviewPlanContext(
  args: BuildActionReviewPlanContextArgs
): Promise<ActionReviewPlanContext> {
  const now = args.now ?? Date.now()
  const listAuthKeys = args.listAuthKeys ?? listActionReviewAuthKeys
  const [fencedFingerprints, instructionGrants] = await Promise.all([
    fingerprintsFor("deny", args.origin, now, listAuthKeys),
    fingerprintsFor("grant", args.origin, now, listAuthKeys),
  ])

  const policyGrants = new Map<string, string>()
  for (const list of args.policyGrants ?? []) {
    for (const fingerprint of list.fingerprints) {
      if (!policyGrants.has(fingerprint)) policyGrants.set(fingerprint, list.policyRef)
    }
  }

  const thread = args.origin.originThread
  return {
    mode: readOutboundAuthorizationMode(args.settings),
    unattended: args.unattended,
    via: args.via,
    originFingerprints: new Set(thread ? [outboundFingerprint(thread)] : []),
    fencedFingerprints,
    instructionGrants,
    policyGrants,
  }
}
